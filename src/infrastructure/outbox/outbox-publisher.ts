import { SQSClient, SendMessageCommand, } from '@aws-sdk/client-sqs';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, } from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
interface PendingOutboxEvent {
    id: string;
    aggregate_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    attempts: number;
}
interface ClaimedOutboxEvent extends PendingOutboxEvent {
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 10;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(OutboxPublisher.name);
    private readonly sqs: SQSClient;
    private readonly queueUrl: string;
    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    private stopped = false;
    constructor(private readonly dataSource: DataSource, private readonly configService: ConfigService, 
    @Optional()
    private readonly tracerService: TracerService) {
        const endpoint = this.configService.get<string>('SQS_ENDPOINT');
        const region = this.configService.get<string>('AWS_REGION') ?? 'us-east-1';
        this.queueUrl =
            this.configService.get<string>('SQS_OUTBOX_QUEUE_URL') ??
                'http://localhost:4566/000000000000/wager-transaction-events.fifo';
        this.sqs = new SQSClient({
            region,
            ...(endpoint ? { endpoint } : {}),
            ...(this.configService.get<string>('AWS_ACCESS_KEY_ID') &&
                this.configService.get<string>('AWS_SECRET_ACCESS_KEY')
                ? {
                    credentials: {
                        accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
                        secretAccessKey: this.configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
                    },
                }
                : {}),
        });
    }
    onModuleInit(): void {
        if (this.configService.get<string>('OUTBOX_PUBLISHER_ENABLED') === 'false') {
            this.logger.log(JSON.stringify({
                event: 'outbox_publisher_disabled',
            }));
            return;
        }
        this.timer = setInterval(() => {
            void this.publishPending();
        }, POLL_INTERVAL_MS);
        this.logger.log(JSON.stringify({ event: 'outbox_publisher_started' }));
        void this.publishPending();
    }
    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
        }
        while (this.running) {
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        this.sqs.destroy();
    }
    private async recordOutboxLag(): Promise<void> {
        if (!this.tracerService) {
            return;
        }
        try {
            const rows = (await this.dataSource.query(`
        SELECT
          COALESCE(
            EXTRACT(
              EPOCH FROM (NOW() - MIN(created_at))
            ) * 1000,
            0
          ) AS lag_ms
        FROM outbox_events
        WHERE published_at IS NULL
          AND next_attempt_at <= NOW()
      `)) as Array<{
                lag_ms: string | number;
            }>;
            const lagMs = Number(rows[0]?.lag_ms ?? 0);
            if (!Number.isFinite(lagMs) || lagMs < 0) {
                return;
            }
            this.tracerService
                .summary('outbox_lag_ms', {
                description: 'Idade do evento elegível mais antigo ainda pendente na Outbox, em milissegundos.',
            })
                .observe(lagMs);
        }
        catch {
        }
    }
    private eventLogContext(event: PendingOutboxEvent): Record<string, string> {
        const payload = event.payload;
        const data = isRecord(payload.data) ? payload.data : undefined;
        return {
            eventId: event.id,
            eventType: event.event_type,
            aggregateId: event.aggregate_id,
            ...(typeof payload.correlationId === 'string'
                ? { correlationId: payload.correlationId }
                : {}),
            ...(typeof data?.transactionId === 'string'
                ? { transactionId: data.transactionId }
                : {}),
            ...(typeof data?.walletId === 'string'
                ? { walletId: data.walletId }
                : {}),
            ...(typeof data?.providerId === 'string'
                ? { providerId: data.providerId }
                : {}),
        };
    }
    async publishPending(): Promise<void> {
        if (this.running || this.stopped) {
            return;
        }
        this.running = true;
        try {
            await this.recordOutboxLag();
            await this.dataSource.transaction(async (manager) => {
                const events = (await manager.query(`
            SELECT
              id,
              aggregate_id,
              event_type,
              payload,
              attempts
            FROM outbox_events
            WHERE published_at IS NULL
              AND next_attempt_at <= NOW()
            ORDER BY created_at ASC, id ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          `, [BATCH_SIZE])) as ClaimedOutboxEvent[];
                for (const event of events) {
                    try {
                        await this.sqs.send(new SendMessageCommand({
                            QueueUrl: this.queueUrl,
                            MessageBody: JSON.stringify(event.payload),
                            MessageGroupId: event.aggregate_id,
                            MessageDeduplicationId: event.id,
                        }));
                        await manager.query(`
                UPDATE outbox_events
                SET published_at = NOW(),
                    last_error = NULL
                WHERE id = $1
                  AND published_at IS NULL
              `, [event.id]);
                        this.logger.log(JSON.stringify({
                            event: 'outbox_event_published',
                            ...this.eventLogContext(event),
                        }));
                    }
                    catch (error: unknown) {
                        const message = error instanceof Error
                            ? error.message.slice(0, 2000)
                            : 'Erro desconhecido ao publicar evento';
                        await manager.query(`
                UPDATE outbox_events
                SET attempts = attempts + 1,
                    next_attempt_at = NOW() +
                      (
                        LEAST(
                          1000 * POWER(2, LEAST(attempts, 10)),
                          $2
                        ) * INTERVAL '1 millisecond'
                      ),
                    last_error = $3
                WHERE id = $1
                  AND published_at IS NULL
              `, [event.id, MAX_RETRY_DELAY_MS, message]);
                        this.logger.error(JSON.stringify({
                            event: 'outbox_event_publish_retry_scheduled',
                            ...this.eventLogContext(event),
                            errorName: error instanceof Error ? error.name : 'UnknownError',
                        }));
                    }
                }
            });
        }
        catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Erro desconhecido';
            this.logger.error(JSON.stringify({
                event: 'outbox_batch_processing_failed',
                error: message.slice(0, 500),
            }));
        }
        finally {
            this.running = false;
        }
    }
}
