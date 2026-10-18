
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';

import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox-publisher.js';

describe('OutboxPublisher — integração PostgreSQL + LocalStack SQS', () => {
  let dataSource: DataSource;
  let publisher: OutboxPublisher;
  let secondPublisher: OutboxPublisher;
  let configService: ConfigService;
  let sqs: SQSClient;
  let queueUrl: string;

  const createdEventIds: string[] = [];

  beforeAll(async () => {
    if (
      process.env.DB_DATABASE !== 'jg_backend_integration' ||
      process.env.DB_PORT !== '55432'
    ) {
      throw new Error(
        'Teste bloqueado: configure DB_DATABASE=jg_backend_integration e DB_PORT=55432.',
      );
    }

    const endpoint =
      process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

    // A Outbox publica na fila de saída, não na fila de entrada.
      queueUrl =
        process.env.SQS_OUTBOX_QUEUE_URL ??
        'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transaction-events.fifo';

    const region = process.env.AWS_REGION ?? 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? 'test';
    const secretAccessKey =
      process.env.AWS_SECRET_ACCESS_KEY ?? 'test';

    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: 55432,
      username: process.env.DB_USERNAME ?? 'postgres',
      password:
        process.env.DB_PASSWORD || 'integration_only_password',
      database: 'jg_backend_integration',
      synchronize: false,
      migrationsRun: false,
    });

    await dataSource.initialize();

    sqs = new SQSClient({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    configService = new ConfigService({
      SQS_ENDPOINT: endpoint,
      SQS_OUTBOX_QUEUE_URL: queueUrl,
      AWS_REGION: region,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      OUTBOX_PUBLISHER_ENABLED: 'false',
    });

    publisher = new OutboxPublisher(dataSource, configService);
  });

  afterAll(async () => {
    if (publisher) {
      await publisher.onModuleDestroy();
    }

    if (secondPublisher) {
      await secondPublisher.onModuleDestroy();
    }

    if (dataSource?.isInitialized) {
      if (createdEventIds.length > 0) {
        await dataSource.query(
          'DELETE FROM outbox_events WHERE id = ANY($1::uuid[])',
          [createdEventIds],
        );
      }

      await dataSource.destroy();
    }

     sqs?.destroy();
  });

  it('publica uma mensagem FIFO real e marca o evento como publicado no PostgreSQL', async () => {
    const eventId = randomUUID();
    const aggregateId = randomUUID();
    createdEventIds.push(eventId);

    const payload = {
      eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        transactionId: randomUUID(),
        amount: '12.50',
        currency: 'BRL',
      },
    };

    await dataSource.query(
      `
        INSERT INTO outbox_events (
          id,
          aggregate_type,
          aggregate_id,
          event_type,
          payload,
          created_at,
          next_attempt_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          COALESCE(
            (
              SELECT MIN(created_at)
              FROM outbox_events
              WHERE published_at IS NULL
                AND next_attempt_at <= NOW()
            ),
            NOW()
          ) - INTERVAL '1 second',
          NOW()
        )
      `,
      [
        eventId,
        'Wallet',
        aggregateId,
        payload.eventType,
        JSON.stringify(payload),
      ],
    );

    await publisher.publishPending();

    const [persistedEvent] = await dataSource.query(
      `
        SELECT published_at, attempts, last_error
        FROM outbox_events
        WHERE id = $1
      `,
      [eventId],
    );

    expect(persistedEvent.published_at).not.toBeNull();
    expect(persistedEvent.attempts).toBe(0);
    expect(persistedEvent.last_error).toBeNull();

    let receivedPayload: unknown;
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline && receivedPayload === undefined) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 1,
        }),
      );

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) {
          continue;
        }

        let body: { eventId?: string };

        try {
          body = JSON.parse(message.Body) as { eventId?: string };
        } catch {
          continue;
        }

        if (body.eventId !== eventId) {
          continue;
        }

        receivedPayload = body;

        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        break;
      }
    }

    expect(receivedPayload).toEqual(payload);
  });

  it('processa eventos com dois publishers concorrentes sem perder eventos', async () => {
    const secondPublisherInstance = new OutboxPublisher(
      dataSource,
      configService,
    );

    secondPublisher = secondPublisherInstance;

    const eventIds: string[] = [];
    const expectedPayloads = new Map<string, unknown>();

    const [anchor] = await dataSource.query(`
      SELECT
        COALESCE(MIN(created_at), NOW()) - INTERVAL '1 second'
          AS created_at
      FROM outbox_events
      WHERE published_at IS NULL
        AND next_attempt_at <= NOW()
    `);

    for (let index = 0; index < 12; index++) {
      const eventId = randomUUID();
      const aggregateId = randomUUID();

      eventIds.push(eventId);
      createdEventIds.push(eventId);

      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: randomUUID(),
        occurredAt: new Date().toISOString(),
        version: 1,
        data: {
          transactionId: randomUUID(),
          amount: '12.50',
          currency: 'BRL',
        },
      };

      expectedPayloads.set(eventId, payload);

      await dataSource.query(
        `
          INSERT INTO outbox_events (
            id,
            aggregate_type,
            aggregate_id,
            event_type,
            payload,
            created_at,
            next_attempt_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        `,
        [
          eventId,
          'Wallet',
          aggregateId,
          payload.eventType,
          JSON.stringify(payload),
          anchor.created_at,
        ],
      );
    }

    await Promise.all([
      publisher.publishPending(),
      secondPublisherInstance.publishPending(),
    ]);

    const persistedEvents = await dataSource.query(
      `
        SELECT id, published_at, attempts, last_error
        FROM outbox_events
        WHERE id = ANY($1::uuid[])
      `,
      [eventIds],
    );

    expect(persistedEvents).toHaveLength(12);

    for (const event of persistedEvents) {
      expect(event.published_at).not.toBeNull();
      expect(event.attempts).toBe(0);
      expect(event.last_error).toBeNull();
    }

    const receivedIds = new Set<string>();
    const deadline = Date.now() + 15_000;

    while (
      Date.now() < deadline &&
      receivedIds.size < eventIds.length
    ) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 1,
        }),
      );

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) {
          continue;
        }

        let body: { eventId?: string };

        try {
          body = JSON.parse(message.Body) as { eventId?: string };
        } catch {
          continue;
        }

        if (!expectedPayloads.has(body.eventId ?? '')) {
          continue;
        }

        const eventId = body.eventId!;

        expect(receivedIds.has(eventId)).toBe(false);
        receivedIds.add(eventId);

        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }

    expect([...receivedIds].sort()).toEqual([...eventIds].sort());
  });

  it('agenda nova tentativa após falha no SQS e recupera os eventos', async () => {
    const eventIds: string[] = [];
    const expectedPayloads = new Map<string, unknown>();

    const [anchor] = await dataSource.query(`
      SELECT
        COALESCE(MIN(created_at), NOW()) - INTERVAL '1 second'
          AS created_at
      FROM outbox_events
      WHERE published_at IS NULL
        AND next_attempt_at <= NOW()
    `);

    // O publicador processa lotes de 10.
    for (let index = 0; index < 10; index++) {
      const eventId = randomUUID();
      const aggregateId = randomUUID();

      eventIds.push(eventId);
      createdEventIds.push(eventId);

      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        correlationId: randomUUID(),
        occurredAt: new Date().toISOString(),
        version: 1,
        data: {
          transactionId: randomUUID(),
          amount: '25.00',
          currency: 'BRL',
        },
      };

      expectedPayloads.set(eventId, payload);

      await dataSource.query(
        `
          INSERT INTO outbox_events (
            id,
            aggregate_type,
            aggregate_id,
            event_type,
            payload,
            created_at,
            next_attempt_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        `,
        [
          eventId,
          'Wallet',
          aggregateId,
          payload.eventType,
          JSON.stringify(payload),
          anchor.created_at,
        ],
      );
    }

    const failingConfig = new ConfigService({
      SQS_ENDPOINT:
        configService.getOrThrow<string>('SQS_ENDPOINT'),
      SQS_OUTBOX_QUEUE_URL:
        'http://localhost:4566/000000000000/queue-does-not-exist.fifo',
      AWS_REGION:
        configService.getOrThrow<string>('AWS_REGION'),
      AWS_ACCESS_KEY_ID:
        configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY:
        configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      OUTBOX_PUBLISHER_ENABLED: 'false',
    });

    const failingPublisher = new OutboxPublisher(
      dataSource,
      failingConfig,
    );

    try {
      await failingPublisher.publishPending();
    } finally {
      await failingPublisher.onModuleDestroy();
    }

    const failedEvents = await dataSource.query(
      `
        SELECT id, published_at, attempts, next_attempt_at, last_error
        FROM outbox_events
        WHERE id = ANY($1::uuid[])
      `,
      [eventIds],
    );

    expect(failedEvents).toHaveLength(10);

    for (const event of failedEvents) {
      expect(event.published_at).toBeNull();
      expect(event.attempts).toBe(1);
      expect(event.last_error).toBeTruthy();
    }

    // Torna os eventos elegíveis imediatamente apenas neste teste.
    await dataSource.query(
      `
        UPDATE outbox_events
        SET next_attempt_at = NOW() - INTERVAL '1 second'
        WHERE id = ANY($1::uuid[])
          AND published_at IS NULL
      `,
      [eventIds],
    );

    await publisher.publishPending();

    const recoveredEvents = await dataSource.query(
      `
        SELECT id, published_at, attempts, last_error
        FROM outbox_events
        WHERE id = ANY($1::uuid[])
      `,
      [eventIds],
    );

    expect(recoveredEvents).toHaveLength(10);

    for (const event of recoveredEvents) {
      expect(event.published_at).not.toBeNull();
      expect(event.attempts).toBe(1);
      expect(event.last_error).toBeNull();
    }

    const receivedIds = new Set<string>();
    const deadline = Date.now() + 15_000;

    while (
      Date.now() < deadline &&
      receivedIds.size < eventIds.length
    ) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 1,
        }),
      );

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) {
          continue;
        }

        let body: { eventId?: string };

        try {
          body = JSON.parse(message.Body) as { eventId?: string };
        } catch {
          continue;
        }

        if (!expectedPayloads.has(body.eventId ?? '')) {
          continue;
        }

        const eventId = body.eventId!;

        expect(receivedIds.has(eventId)).toBe(false);
        receivedIds.add(eventId);

        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }

    expect([...receivedIds].sort()).toEqual([...eventIds].sort());
  });
});
