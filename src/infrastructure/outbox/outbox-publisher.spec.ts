import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxPublisher } from './outbox-publisher.js';
import { TracerService } from '@nestjs/observe';

const event = {
  id: 'd4f4ac48-b6a7-4d0c-a0e2-cf0f1a20b2b1',
  aggregate_id: 'ec7bb64d-5a5e-4c17-85b0-1a86d5e2b4a7',
  event_type: 'WagerTransactionProcessed',
  payload: {
    eventId: 'd4f4ac48-b6a7-4d0c-a0e2-cf0f1a20b2b1',
    amount: '125.50',
  },
  attempts: 0,
};


function createPublisher(
  enabled = false,
  withTracer = false,
) {
  const query = vi.fn();
  const manager = { query };

  const outboxLagQuery = vi.fn().mockResolvedValue([
    { lag_ms: '2500' },
  ]);

  const dataSource = {
    query: outboxLagQuery,
    transaction: vi.fn(
      async (
        callback: (manager: { query: typeof query }) => Promise<unknown>,
      ) => callback(manager),
    ),
  } as unknown as DataSource;

  const values: Record<string, string> = {
    OUTBOX_PUBLISHER_ENABLED: String(enabled),
    AWS_REGION: 'us-east-1',
    SQS_ENDPOINT: 'http://localhost:4566',
    SQS_OUTBOX_QUEUE_URL:
      'http://localhost:4566/000000000000/wager-transaction-events.fifo',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  };

  const configService = {
    get: vi.fn((key: string) => values[key]),
    getOrThrow: vi.fn((key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`Configuração ausente: ${key}`);
      }

      return value;
    }),
  } as unknown as ConfigService;

  const observe = vi.fn();
  const summary = vi.fn(() => ({ observe }));

  const tracerService = withTracer
    ? ({ summary } as unknown as TracerService)
    : undefined;

  const publisher = new OutboxPublisher(
    dataSource,
    configService,
    tracerService as TracerService,
  );

  const sendSpy = vi.spyOn(publisher['sqs'], 'send');

  return {
    publisher,
    query,
    dataSource,
    sendSpy,
    outboxLagQuery,
    summary,
    observe,
  };
}


describe('OutboxPublisher', () => {
  let currentPublisher: OutboxPublisher | undefined;

  afterEach(async () => {
    if (currentPublisher) {
      await currentPublisher.onModuleDestroy();
      currentPublisher = undefined;
    }

    vi.restoreAllMocks();
  });

  it('publica o evento na fila FIFO e marca-o como publicado', async () => {
    const context = createPublisher();
    currentPublisher = context.publisher;

    context.query
      .mockResolvedValueOnce([event])
      .mockResolvedValueOnce([]);

    context.sendSpy.mockResolvedValueOnce({
      MessageId: 'sqs-message-id',
    } as never);

    await context.publisher.publishPending();

    expect(context.sendSpy).toHaveBeenCalledTimes(1);

    const command = context.sendSpy.mock.calls[0][0] as SendMessageCommand;

    expect(command.input.QueueUrl).toBe(
      'http://localhost:4566/000000000000/wager-transaction-events.fifo',
    );

    expect(command.input.MessageGroupId).toBe(event.aggregate_id);
    expect(command.input.MessageDeduplicationId).toBe(event.id);
    expect(command.input.MessageBody).toBe(JSON.stringify(event.payload));

    expect(context.query).toHaveBeenCalledTimes(2);
    expect(context.query.mock.calls[1][0]).toContain(
      'SET published_at = NOW()',
    );
    expect(context.query.mock.calls[1][1]).toEqual([event.id]);
  });

  it('agenda uma nova tentativa quando o envio ao SQS falha', async () => {
    const context = createPublisher();
    currentPublisher = context.publisher;

    context.query
      .mockResolvedValueOnce([event])
      .mockResolvedValueOnce([]);

    context.sendSpy.mockRejectedValueOnce(new Error('SQS indisponível'));

    await context.publisher.publishPending();

    expect(context.sendSpy).toHaveBeenCalledTimes(1);
    expect(context.query).toHaveBeenCalledTimes(2);

    const [sql, parameters] = context.query.mock.calls[1];

    expect(sql).toContain('attempts = attempts + 1');
    expect(sql).toContain('next_attempt_at');
    expect(parameters).toEqual([
      event.id,
      15 * 60 * 1_000,
      'SQS indisponível',
    ]);
  });

  it('não inicia a publicação quando está desativado', async () => {
    const context = createPublisher(false);
    currentPublisher = context.publisher;

    const publishSpy = vi.spyOn(context.publisher, 'publishPending');
    const transactionSpy = vi.spyOn(
      context.dataSource,
      'transaction',
    );

    context.publisher.onModuleInit();

    expect(publishSpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(context.sendSpy).not.toHaveBeenCalled();
  });

  it('impede duas publicações simultâneas na mesma instância', async () => {
    const context = createPublisher();
    currentPublisher = context.publisher;

    context.query
      .mockResolvedValueOnce([event])
      .mockResolvedValueOnce([]);

    let releaseSend!: (value: unknown) => void;

    context.sendSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSend = resolve;
        }) as never,
    );

    const transactionSpy = vi.spyOn(
      context.dataSource,
      'transaction',
    );

    const firstPublication = context.publisher.publishPending();

    await vi.waitFor(() => {
      expect(context.sendSpy).toHaveBeenCalledTimes(1);
    });

    const secondPublication = context.publisher.publishPending();

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(context.sendSpy).toHaveBeenCalledTimes(1);

    releaseSend({ MessageId: 'sqs-message-id' });

    await Promise.all([firstPublication, secondPublication]);

    expect(context.query).toHaveBeenCalledTimes(2);
  });

  it('trata falha no banco após o envio ao SQS sem confirmar a publicação', async () => {
    const context = createPublisher();
    currentPublisher = context.publisher;

    context.query
      .mockResolvedValueOnce([event])
      .mockRejectedValueOnce(
        new Error('Falha ao atualizar published_at'),
      )
      .mockRejectedValueOnce(new Error('Falha ao reagendar evento'));

    context.sendSpy.mockResolvedValueOnce({
      MessageId: 'sqs-message-id',
    } as never);

    await context.publisher.publishPending();

    
    expect(context.sendSpy).toHaveBeenCalledTimes(1);
    expect(context.query).toHaveBeenCalledTimes(3);
    expect(context.query.mock.calls[1][0]).toContain(
      'SET published_at = NOW()',
    );
    expect(context.query.mock.calls[2][0]).toContain(
      'attempts = attempts + 1',
    );
  });
  
it('registra a métrica com o atraso da Outbox em milissegundos', async () => {
  const context = createPublisher(false, true);
  currentPublisher = context.publisher;

  context.query.mockResolvedValueOnce([]);

  await context.publisher.publishPending();

  expect(context.outboxLagQuery).toHaveBeenCalledTimes(1);
  expect(context.outboxLagQuery.mock.calls[0][0]).toContain(
    'MIN(created_at)',
  );

  expect(context.summary).toHaveBeenCalledWith(
    'outbox_lag_ms',
    expect.objectContaining({
      description: expect.any(String),
    }),
  );

  expect(context.observe).toHaveBeenCalledWith(2500);
  expect(context.sendSpy).not.toHaveBeenCalled();
});

it('registra atraso zero quando não há eventos elegíveis', async () => {
  const context = createPublisher(false, true);
  currentPublisher = context.publisher;

  context.outboxLagQuery.mockResolvedValueOnce([
    { lag_ms: '0' },
  ]);
  context.query.mockResolvedValueOnce([]);

  await context.publisher.publishPending();

  expect(context.observe).toHaveBeenCalledWith(0);
});

it('continua a publicação quando a consulta da métrica falha', async () => {
  const context = createPublisher(false, true);
  currentPublisher = context.publisher;

  context.outboxLagQuery.mockRejectedValueOnce(
    new Error('Falha na consulta da métrica'),
  );
  context.query.mockResolvedValueOnce([event]).mockResolvedValueOnce([]);
  context.sendSpy.mockResolvedValueOnce({
    MessageId: 'sqs-message-id',
  } as never);

  await context.publisher.publishPending();

  expect(context.sendSpy).toHaveBeenCalledTimes(1);
  expect(context.query).toHaveBeenCalledTimes(2);
});

});