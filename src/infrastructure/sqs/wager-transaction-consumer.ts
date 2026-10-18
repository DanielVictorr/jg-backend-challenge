import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, } from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import { ConfigService } from '@nestjs/config';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient, } from '@aws-sdk/client-sqs';
import { HttpException } from '@nestjs/common';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import { parseWagerTransactionMessage } from './wager-transaction-message.js';
const CONSUMER_NAME = 'wager-transaction-consumer';
const MAX_MESSAGES = 10;
const WAIT_TIME_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43200;
@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(WagerTransactionConsumer.name);
    private readonly client: SQSClient;
    private readonly queueUrl: string;
    private readonly visibilityTimeoutSeconds: number;
    private readonly enabled: boolean;
    private stopping = false;
    private loopPromise: Promise<void> | undefined;
    private readonly receiveAbortController = new AbortController();
    constructor(private readonly config: ConfigService, private readonly processor: ProcessWagerTransaction, 
    @Optional()
    private readonly tracerService?: TracerService) {
        this.enabled =
            this.config.get<string>('SQS_CONSUMER_ENABLED', 'false') === 'true';
        this.queueUrl = this.enabled
            ? this.config.getOrThrow<string>('SQS_QUEUE_URL')
            : this.config.get<string>('SQS_QUEUE_URL', '');
        const configuredVisibilityTimeout = Number(this.config.get<string>(
            'SQS_VISIBILITY_TIMEOUT_SECONDS',
            String(DEFAULT_VISIBILITY_TIMEOUT_SECONDS),
        ));
        if (!Number.isInteger(configuredVisibilityTimeout) ||
            configuredVisibilityTimeout < 0 ||
            configuredVisibilityTimeout > MAX_VISIBILITY_TIMEOUT_SECONDS) {
            throw new RangeError('SQS_VISIBILITY_TIMEOUT_SECONDS deve ser um inteiro entre 0 e 43200.');
        }
        this.visibilityTimeoutSeconds = configuredVisibilityTimeout;
        this.client = new SQSClient({
            region: this.config.get<string>('AWS_REGION', 'us-east-1'),
            endpoint: this.config.get<string>('SQS_ENDPOINT'),
            credentials: {
                accessKeyId: this.config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
                secretAccessKey: this.config.get<string>('AWS_SECRET_ACCESS_KEY', 'test'),
            },
        });
    }
    onModuleInit(): void {
        if (!this.enabled) {
            this.logger.log(JSON.stringify({
                event: 'sqs_consumer_disabled',
                message: 'Defina SQS_CONSUMER_ENABLED=true para ativar o consumidor.',
            }));
            return;
        }
        this.logger.log(JSON.stringify({ event: 'sqs_consumer_started' }));
        this.loopPromise = this.consumeLoop();
    }
    async onModuleDestroy(): Promise<void> {
        this.stopping = true;
        this.receiveAbortController.abort();
        try {
            await this.loopPromise;
        }
        finally {
            this.client.destroy();
            this.logger.log(JSON.stringify({ event: 'sqs_consumer_stopped' }));
        }
    }
    private async consumeLoop(): Promise<void> {
        while (!this.stopping) {
            try {
                const response = await this.client.send(new ReceiveMessageCommand({
                    QueueUrl: this.queueUrl,
                    MaxNumberOfMessages: MAX_MESSAGES,
                    WaitTimeSeconds: WAIT_TIME_SECONDS,
                    VisibilityTimeout: this.visibilityTimeoutSeconds,
                }), { abortSignal: this.receiveAbortController.signal });
                const messages = response.Messages ?? [];
                for (let index = 0; index < messages.length; index++) {
                    const message = messages[index];
                    if (this.stopping) {
                        for (const pendingMessage of messages.slice(index)) {
                            await this.returnMessageToQueue(pendingMessage.ReceiptHandle);
                        }
                        break;
                    }
                    if (!message.ReceiptHandle || !message.Body) {
                        this.logger.error(JSON.stringify({
                            event: 'sqs_message_missing_body_or_receipt_handle',
                        }));
                        continue;
                    }
                    await this.processMessage(message.Body, message.ReceiptHandle);
                }
            }
            catch (error) {
                if (this.stopping) {
                    break;
                }
                this.logger.error(JSON.stringify({
                    event: 'sqs_receive_or_process_failed',
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                }));
                await this.delay(1000);
            }
        }
    }
    private recordCounter(name: string, description: string): void {
        try {
            this.tracerService
                ?.counter(name, { description })
                .increment();
        }
        catch {
        }
    }
    private async processMessage(body: string, receiptHandle: string): Promise<void> {
        let parsed: ReturnType<typeof parseWagerTransactionMessage>;
        try {
            parsed = parseWagerTransactionMessage(body);
        }
        catch (error) {
            if (error instanceof HttpException && error.getStatus() < 500) {
                this.recordCounter('wager_messages_left_for_dlq_redrive_total', 'Mensagens inválidas deixadas na fila para possível redrive à DLQ.');
                this.logger.warn(JSON.stringify({
                    event: 'sqs_invalid_message_pending_dlq_redrive',
                }));
                return;
            }
            this.logger.error(JSON.stringify({
                event: 'sqs_message_parse_failed',
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }));
            return;
        }
        const messageContext = {
            correlationId: parsed.messageId,
            messageId: parsed.messageId,
            walletId: parsed.input.walletId,
            providerId: parsed.input.providerId,
        };
        try {
            const result = await this.processor.execute(parsed.input, {
                consumerName: CONSUMER_NAME,
                messageId: parsed.messageId,
                payloadHash: parsed.payloadHash,
            });
            await this.deleteMessage(receiptHandle);
            if ('duplicateMessage' in result) {
                this.logger.log(JSON.stringify({
                    event: 'sqs_duplicate_message_acknowledged',
                    ...messageContext,
                }));
            }
            else {
                this.logger.log(JSON.stringify({
                    event: 'sqs_message_processed',
                    ...messageContext,
                    transactionId: result.transactionId,
                    status: result.status,
                }));
            }
        }
        catch (error) {
            if (error instanceof HttpException && error.getStatus() < 500) {
                this.logger.warn(JSON.stringify({
                    event: 'sqs_message_rejected_terminally',
                    ...messageContext,
                    statusCode: error.getStatus(),
                }));
                await this.deleteMessage(receiptHandle);
                return;
            }
            this.recordCounter('wager_sqs_processing_retries_total', 'Falhas transitórias no processamento SQS que permitem nova tentativa.');
            this.logger.error(JSON.stringify({
                event: 'sqs_message_processing_retry',
                ...messageContext,
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }));
        }
    }
    private async deleteMessage(receiptHandle: string): Promise<void> {
        await this.client.send(new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
        }));
    }
    private async returnMessageToQueue(receiptHandle: string | undefined): Promise<void> {
        if (!receiptHandle) {
            return;
        }
        try {
            await this.client.send(new ChangeMessageVisibilityCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: receiptHandle,
                VisibilityTimeout: 0,
            }));
            this.logger.log(JSON.stringify({
                event: 'sqs_message_returned_during_shutdown',
            }));
        }
        catch (error) {
            this.logger.error(JSON.stringify({
                event: 'sqs_message_return_failed_during_shutdown',
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }));
        }
    }
    private async delay(milliseconds: number): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
        });
    }
}
