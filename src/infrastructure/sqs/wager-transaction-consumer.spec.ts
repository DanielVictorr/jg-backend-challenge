
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sqsMocks.send;
    destroy = sqsMocks.destroy;
  },
  ReceiveMessageCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteMessageCommand: class {
    constructor(public input: unknown) {}
  },
  ChangeMessageVisibilityCommand: class {
  constructor(public input: unknown) {}
  },
}));

import { WagerTransactionConsumer } from './wager-transaction-consumer.js';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';

const validBody = JSON.stringify({
  messageId: 'message-test-001',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-17T12:00:00.000Z',
  data: {
    providerId: 'provider-test',
    externalTransactionId: 'external-test-001',
    idempotencyKey: 'idempotency-test-001',
    playerId: 'player-test',
    walletId: '00000000-0000-4000-8000-000000000001',
    roundId: 'round-test',
    gameId: 'game-test',
    kind: 'BET',
    money: {
      amount: '10.00',
      currency: 'BRL',
    },
  },
});

function createConsumer(options?: {
  enabled?: boolean;
  queueUrl?: string;
  execute?: ReturnType<typeof vi.fn>;
}) {
  const config = {
    get: vi.fn((key: string, fallback?: string) => {
      const values: Record<string, string> = {
        SQS_CONSUMER_ENABLED: String(options?.enabled ?? false),
        SQS_QUEUE_URL: options?.queueUrl ?? 'http://localhost:4566/test-queue',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      };

      return values[key] ?? fallback;
    }),
    getOrThrow: vi.fn((key: string) => {
      if (key === 'SQS_QUEUE_URL') {
        const value = options?.queueUrl ??
          'http://localhost:4566/test-queue';

        if (!value) {
          throw new Error(`Missing configuration: ${key}`);
        }

        return value;
      }

      throw new Error(`Unexpected configuration: ${key}`);
    }),
  };

  const processor = {
    execute: options?.execute ?? vi.fn().mockResolvedValue({
      transactionId: 'transaction-test-001',
      status: 'Processed',
    }),
  };

  const increment = vi.fn();
  const counter = vi.fn(() => ({ increment }));
  const tracerService = { counter };

  const consumer = new WagerTransactionConsumer(
    config as never,
    processor as unknown as ProcessWagerTransaction,
    tracerService as never,
  );

  return { consumer, processor, counter, increment };
}

function invokeProcessMessage(
  consumer: WagerTransactionConsumer,
  body: string,
  receiptHandle = 'receipt-test-001',
) {
  return (
    consumer as unknown as {
      processMessage(body: string, receiptHandle: string): Promise<void>;
    }
  ).processMessage(body, receiptHandle);
}

describe('WagerTransactionConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqsMocks.send.mockResolvedValue({});
  });

  it('não inicia o polling quando está desativado', () => {
    const { consumer } = createConsumer();

    consumer.onModuleInit();

    expect(sqsMocks.send).not.toHaveBeenCalled();
  });

  it('registra mensagem inválida deixada para redrive à DLQ', async () => {
    const { consumer, processor, counter, increment } = createConsumer();

    await invokeProcessMessage(consumer, '{json-invalido');

    expect(processor.execute).not.toHaveBeenCalled();
    expect(counter).toHaveBeenCalledWith(
      'wager_messages_left_for_dlq_redrive_total',
      expect.objectContaining({
        description: expect.any(String),
      }),
    );
    expect(increment).toHaveBeenCalledOnce();
  });

  it('registra falha transitória do processamento para nova tentativa', async () => {
    const execute = vi.fn().mockRejectedValue(
      new Error('Falha temporária no banco'),
    );

    const { consumer, counter, increment } = createConsumer({ execute });

      await invokeProcessMessage(consumer, validBody);

      expect(counter).toHaveBeenCalledWith(
        'wager_sqs_processing_retries_total',
        expect.objectContaining({
          description: expect.any(String),
        }),
      );
      expect(increment).toHaveBeenCalledOnce();
      expect(sqsMocks.send).not.toHaveBeenCalled();
  });

  it('processa a mensagem antes de solicitar sua exclusão', async () => {
    const order: string[] = [];

    const execute = vi.fn().mockImplementation(async () => {
      order.push('process');
      return {
        transactionId: 'transaction-test-001',
        status: 'Processed',
      };
  });
  
    sqsMocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof Object &&
          command.constructor.name === 'DeleteMessageCommand') {
        order.push('delete');
      }

      return {};
    });

    const { consumer } = createConsumer({ execute });

    await invokeProcessMessage(consumer, validBody);

    expect(execute).toHaveBeenCalledOnce();
    expect(order).toEqual(['process', 'delete']);

    const context = execute.mock.calls[0]?.[1];

    expect(context).toMatchObject({
      consumerName: 'wager-transaction-consumer',
      messageId: 'message-test-001',
    });
    expect(context.payloadHash).toEqual(expect.any(String));
  });

  it('não exclui a mensagem quando ocorre erro transitório', async () => {
    const execute = vi.fn().mockRejectedValue(
      new Error('Falha temporária no banco'),
    );

    const { consumer } = createConsumer({ execute });

    await invokeProcessMessage(consumer, validBody);

    expect(execute).toHaveBeenCalledOnce();
    expect(sqsMocks.send).not.toHaveBeenCalled();
  });

  it('não deve excluir uma mensagem com JSON inválido', async () => {
    const execute = vi.fn();

    const { consumer } = createConsumer({ execute });

    await invokeProcessMessage(consumer, '{json-invalido');

    expect(execute).not.toHaveBeenCalled();
    expect(sqsMocks.send).not.toHaveBeenCalled();
  });

  it('exclui a mensagem quando o Inbox identifica uma duplicata', async () => {
    const execute = vi.fn().mockResolvedValue({
      duplicateMessage: true,
    });

    const { consumer } = createConsumer({ execute });

    await invokeProcessMessage(consumer, validBody);

    expect(execute).toHaveBeenCalledOnce();
    expect(sqsMocks.send).toHaveBeenCalledOnce();
    expect(sqsMocks.send.mock.calls[0]?.[0]?.constructor.name)
      .toBe('DeleteMessageCommand');
  });

  it('não deve excluir a mensagem se a exclusão SQS falhar', async () => {
    sqsMocks.send.mockRejectedValueOnce(
      new Error('SQS indisponível'),
    );

    const { consumer, processor } = createConsumer();

    await invokeProcessMessage(consumer, validBody);

    expect(processor.execute).toHaveBeenCalledOnce();
    expect(sqsMocks.send).toHaveBeenCalledOnce();
  });

  
  it('exclui a mensagem quando o processador lança erro 4xx terminal', async () => {
    const execute = vi.fn().mockRejectedValue(
      new BadRequestException('Mensagem inválida'),
    );

    const { consumer } = createConsumer({ execute });

    await invokeProcessMessage(consumer, validBody);

    expect(execute).toHaveBeenCalledOnce();
    expect(sqsMocks.send).toHaveBeenCalledOnce();
    expect(sqsMocks.send.mock.calls[0]?.[0]?.constructor.name)
      .toBe('DeleteMessageCommand');
  });

  
  it('devolve mensagens ainda não processadas ao encerrar', async () => {
    let releaseProcessing!: () => void;
    let markProcessingStarted!: () => void;

    const processingGate = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });

    const processingStarted = new Promise<void>((resolve) => {
      markProcessingStarted = resolve;
    });

    const execute = vi.fn().mockImplementation(async () => {
      markProcessingStarted();
      await processingGate;

      return {
        transactionId: 'transaction-test-001',
        status: 'Processed',
      };
    });

    sqsMocks.send.mockImplementation(async (command: unknown) => {
      const commandName =
        command instanceof Object ? command.constructor.name : '';

      if (commandName === 'ReceiveMessageCommand') {
        return {
          Messages: [
            { Body: validBody, ReceiptHandle: 'receipt-first' },
            { Body: validBody, ReceiptHandle: 'receipt-pending' },
          ],
        };
      }

      return {};
    });

    const { consumer } = createConsumer({
      enabled: true,
      execute,
    });

    consumer.onModuleInit();

    await processingStarted;

    const shutdown = consumer.onModuleDestroy();
    releaseProcessing();

    await shutdown;

    const commands = sqsMocks.send.mock.calls.map(
      ([command]) =>
        command instanceof Object ? command.constructor.name : '',
    );

    expect(commands).toContain('DeleteMessageCommand');
    expect(commands).toContain('ChangeMessageVisibilityCommand');

    const visibilityCommand = sqsMocks.send.mock.calls.find(
      ([command]) =>
        command instanceof Object &&
        command.constructor.name === 'ChangeMessageVisibilityCommand',
    )?.[0] as { input: Record<string, unknown> } | undefined;

    expect(visibilityCommand?.input).toMatchObject({
      ReceiptHandle: 'receipt-pending',
      VisibilityTimeout: 0,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(sqsMocks.destroy).toHaveBeenCalledOnce();
  });


});
