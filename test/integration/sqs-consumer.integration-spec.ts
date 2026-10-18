import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient, } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
import { WalletEntity } from '../../src/database/entities/wallet.entity.js';
import { WagerTransactionConsumer } from '../../src/infrastructure/sqs/wager-transaction-consumer.js';
describe('SQS Consumer — integração real', () => {
    let app: INestApplication;
    let sqs: SQSClient;
    let dataSource: DataSource;
    let createWallet: CreateWallet;
    let queueUrl: string;
    let crashQueueUrl: string | undefined;
    const originalEnv = {
        SQS_CONSUMER_ENABLED: process.env.SQS_CONSUMER_ENABLED,
        SQS_QUEUE_URL: process.env.SQS_QUEUE_URL,
        SQS_ENDPOINT: process.env.SQS_ENDPOINT,
        OUTBOX_PUBLISHER_ENABLED: process.env.OUTBOX_PUBLISHER_ENABLED,
        SQS_VISIBILITY_TIMEOUT_SECONDS: process.env.SQS_VISIBILITY_TIMEOUT_SECONDS,
    };
    beforeAll(async () => {
        if (process.env.DB_DATABASE !== 'jg_backend_integration' ||
            process.env.DB_PORT !== '55432') {
            throw new Error('Teste bloqueado: configure o banco de integração na porta 55432.');
        }
        process.env.SQS_CONSUMER_ENABLED = 'true';
        process.env.SQS_QUEUE_URL =
            'http://localhost:4566/000000000000/wager-transactions.fifo';
        process.env.SQS_ENDPOINT = 'http://localhost:4566';
        process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
        queueUrl = process.env.SQS_QUEUE_URL;
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        dataSource = app.get(DataSource);
        createWallet = app.get(CreateWallet);
        const config = app.get(ConfigService);
        sqs = new SQSClient({
            region: config.get<string>('AWS_REGION', 'us-east-1'),
            endpoint: 'http://localhost:4566',
            credentials: {
                accessKeyId: 'test',
                secretAccessKey: 'test',
            },
        });
        await sqs.send(new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['QueueArn'],
        }));
    }, 30000);
    afterAll(async () => {
        try {
            await app?.close();
        }
        finally {
            if (crashQueueUrl) {
                await sqs.send(new DeleteQueueCommand({
                    QueueUrl: crashQueueUrl,
                }));
            }
            sqs?.destroy();
            for (const [key, value] of Object.entries(originalEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                }
                else {
                    process.env[key] = value;
                }
            }
        }
    });
    it('processa mensagem real, registra no Inbox e evita débito duplicado na redelivery', async () => {
        const uniqueId = randomUUID();
        const playerId = `sqs-integration-${uniqueId}`;
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: {
                amount: '100.00',
                currency: 'BRL',
            },
        });
        const messageId = `sqs-message-${uniqueId}`;
        const transaction = {
            providerId: `provider-${uniqueId}`,
            externalTransactionId: `external-${uniqueId}`,
            idempotencyKey: `idem-${uniqueId}`,
            playerId,
            walletId: wallet.id,
            roundId: `round-${uniqueId}`,
            gameId: 'sqs-integration-test',
            kind: 'BET',
            money: {
                amount: '10.00',
                currency: 'BRL',
            },
        };
        const body = JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: transaction,
        });
        const send = async () => {
            await sqs.send(new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody: body,
                MessageGroupId: `wallet-${wallet.id}`,
                MessageDeduplicationId: randomUUID(),
            }));
        };
        const getDiagnostics = async (): Promise<string> => {
            const currentWallet = await dataSource
                .getRepository(WalletEntity)
                .findOneBy({ id: wallet.id });
            const inboxRows: Array<{
                count: string;
            }> = await dataSource.query(`SELECT COUNT(*)::text AS count
               FROM processed_messages
              WHERE consumer_name = $1
                AND message_id = $2`, ['wager-transaction-consumer', messageId]);
            const attributes = await sqs.send(new GetQueueAttributesCommand({
                QueueUrl: queueUrl,
                AttributeNames: [
                    'ApproximateNumberOfMessages',
                    'ApproximateNumberOfMessagesNotVisible',
                    'ApproximateNumberOfMessagesDelayed',
                ],
            }));
            return JSON.stringify({
                walletBalance: currentWallet?.balance ?? null,
                inboxCount: inboxRows[0]?.count ?? null,
                queueVisible: attributes.Attributes?.ApproximateNumberOfMessages ?? null,
                queueInFlight: attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ??
                    null,
                queueDelayed: attributes.Attributes?.ApproximateNumberOfMessagesDelayed ??
                    null,
            });
        };
        const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 60000): Promise<void> => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                if (await condition()) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            let diagnostics = 'Não foi possível obter os diagnósticos.';
            try {
                diagnostics = await getDiagnostics();
            }
            catch (error) {
                diagnostics =
                    error instanceof Error ? error.message : String(error);
            }
            throw new Error(`Tempo esgotado aguardando o processamento SQS. Estado: ${diagnostics}`);
        };
        await send();
        await waitUntil(async () => {
            const currentWallet = await dataSource
                .getRepository(WalletEntity)
                .findOneBy({ id: wallet.id });
            const rows: Array<{
                count: string;
            }> = await dataSource.query(`SELECT COUNT(*)::text AS count
             FROM processed_messages
            WHERE consumer_name = $1
              AND message_id = $2
              AND processed_at IS NOT NULL`, ['wager-transaction-consumer', messageId]);
            return (currentWallet?.balance === '90.00' &&
                rows[0]?.count === '1');
        });
        await send();
        await waitUntil(async () => {
            const attributes = await sqs.send(new GetQueueAttributesCommand({
                QueueUrl: queueUrl,
                AttributeNames: [
                    'ApproximateNumberOfMessages',
                    'ApproximateNumberOfMessagesNotVisible',
                ],
            }));
            const currentWallet = await dataSource
                .getRepository(WalletEntity)
                .findOneBy({ id: wallet.id });
            const inboxRows: Array<{
                count: string;
            }> = await dataSource.query(`SELECT COUNT(*)::text AS count
               FROM processed_messages
              WHERE consumer_name = $1
                AND message_id = $2
                AND processed_at IS NOT NULL`, ['wager-transaction-consumer', messageId]);
            const transactions: Array<{
                count: string;
            }> = await dataSource.query(`SELECT COUNT(*)::text AS count
               FROM wagering_transactions
              WHERE provider_id = $1
                AND external_transaction_id = $2`, [
                transaction.providerId,
                transaction.externalTransactionId,
            ]);
            const visible = Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0);
            const inFlight = Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
            return (visible === 0 &&
                inFlight === 0 &&
                currentWallet?.balance === '90.00' &&
                inboxRows[0]?.count === '1' &&
                transactions[0]?.count === '1');
        });
        const finalWallet = await dataSource
            .getRepository(WalletEntity)
            .findOneByOrFail({ id: wallet.id });
        expect(finalWallet.balance).toBe('90.00');
    }, 120000);
    it('recupera redelivery após o processo morrer entre commit e ACK', async () => {
        await app.close();
        process.env.SQS_CONSUMER_ENABLED = 'false';
        const queueName = `crash-recovery-${randomUUID()}.fifo`;
        const createdQueue = await sqs.send(new CreateQueueCommand({
            QueueName: queueName,
            Attributes: {
                FifoQueue: 'true',
                ContentBasedDeduplication: 'true',
                VisibilityTimeout: '1',
            },
        }));
        if (!createdQueue.QueueUrl) {
            throw new Error('LocalStack não retornou a URL da fila de teste.');
        }
        crashQueueUrl = createdQueue.QueueUrl;
        process.env.SQS_QUEUE_URL = crashQueueUrl;
        let moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        dataSource = app.get(DataSource);
        createWallet = app.get(CreateWallet);
        const uniqueId = randomUUID();
        const playerId = `sqs-crash-${uniqueId}`;
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: {
                amount: '100.00',
                currency: 'BRL',
            },
        });
        const messageId = `sqs-crash-message-${uniqueId}`;
        const transaction = {
            providerId: `provider-${uniqueId}`,
            externalTransactionId: `external-${uniqueId}`,
            idempotencyKey: `idem-${uniqueId}`,
            playerId,
            walletId: wallet.id,
            roundId: `round-${uniqueId}`,
            gameId: 'sqs-crash-integration-test',
            kind: 'BET',
            money: {
                amount: '10.00',
                currency: 'BRL',
            },
        };
        await sqs.send(new SendMessageCommand({
            QueueUrl: crashQueueUrl,
            MessageBody: JSON.stringify({
                messageId,
                type: 'WagerTransactionRequested',
                occurredAt: new Date().toISOString(),
                data: transaction,
            }),
            MessageGroupId: `wallet-${wallet.id}`,
            MessageDeduplicationId: randomUUID(),
        }));
        const workerPath = fileURLToPath(new URL('./helpers/process-wager-worker.ts', import.meta.url));
        const child = spawn('bun', ['run', workerPath, JSON.stringify({
            mode: 'receive-process-and-hold',
            queueUrl: crashQueueUrl,
        })], {
            cwd: process.cwd(),
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        const workerOutputPromise = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error('Tempo esgotado aguardando o worker isolado.'));
            }, 60000);
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
                const lineEnd = stdout.indexOf('\n');
                if (lineEnd >= 0) {
                    clearTimeout(timeout);
                    resolve(stdout.slice(0, lineEnd));
                }
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            child.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            child.once('close', (code) => {
                clearTimeout(timeout);
                if (!stdout.includes('\n')) {
                    reject(new Error(`Worker isolado encerrou antes do commit: ${stderr || code}`));
                }
            });
        });
        const workerOutput = await workerOutputPromise;
        const workerResult = JSON.parse(workerOutput) as {
            result: { status: string };
            receiptHandle: string;
        };
        expect(workerResult.result.status).toBe('PROCESSED');
        child.kill('SIGKILL');
        const workerExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('O worker isolado não encerrou após SIGKILL.'));
            }, 10000);
            child.once('close', (code, signal) => {
                clearTimeout(timeout);
                resolve({ code, signal });
            });
        });
        expect(workerExit.signal).toBe('SIGKILL');
        const committedWallet = await dataSource
            .getRepository(WalletEntity)
            .findOneByOrFail({ id: wallet.id });
        expect(committedWallet.balance).toBe('90.00');
        const committedInbox: Array<{ processed_at: Date | null }> = await dataSource.query(`SELECT processed_at
          FROM processed_messages
         WHERE consumer_name = $1
           AND message_id = $2`, ['wager-transaction-consumer', messageId]);
        expect(committedInbox).toHaveLength(1);
        expect(committedInbox[0]?.processed_at).not.toBeNull();
        await app.close();
        process.env.SQS_CONSUMER_ENABLED = 'true';
        process.env.SQS_VISIBILITY_TIMEOUT_SECONDS = '1';
        moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        dataSource = app.get(DataSource);
        const deadline = Date.now() + 60000;
        let recovered = false;
        while (Date.now() < deadline) {
            const [currentWallet] = await dataSource.getRepository(WalletEntity).find({
                where: { id: wallet.id },
            });
            const inboxRows: Array<{ count: string }> = await dataSource.query(`SELECT COUNT(*)::text AS count
              FROM processed_messages
             WHERE consumer_name = $1
               AND message_id = $2
               AND processed_at IS NOT NULL`, ['wager-transaction-consumer', messageId]);
            const ledgerRows: Array<{ debit_count: string }> = await dataSource.query(`SELECT COUNT(*)::text AS debit_count
              FROM ledger_entries
             WHERE wallet_id = $1
               AND entry_type = 'DEBIT'`, [wallet.id]);
            const reconstructedRows: Array<{ balance: string }> = await dataSource.query(`SELECT COALESCE(SUM(
                CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END
              ), 0)::numeric(20, 2)::text AS balance
              FROM ledger_entries
             WHERE wallet_id = $1`, [wallet.id]);
            const queueAttributes = await sqs.send(new GetQueueAttributesCommand({
                QueueUrl: crashQueueUrl,
                AttributeNames: [
                    'ApproximateNumberOfMessages',
                    'ApproximateNumberOfMessagesNotVisible',
                ],
            }));
            const visible = Number(queueAttributes.Attributes?.ApproximateNumberOfMessages ?? 0);
            const inFlight = Number(queueAttributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
            recovered = currentWallet?.balance === '90.00' &&
                currentWallet.balance === reconstructedRows[0]?.balance &&
                inboxRows[0]?.count === '1' &&
                ledgerRows[0]?.debit_count === '1' &&
                visible === 0 &&
                inFlight === 0;
            if (recovered) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(recovered).toBe(true);
    }, 180000);
    it('redrive uma mensagem não confirmada para a DLQ após exceder o limite de recebimentos', async () => {
        const suffix = randomUUID();
        const deadLetter = await sqs.send(new CreateQueueCommand({
            QueueName: `wager-test-dlq-${suffix}.fifo`,
            Attributes: {
                FifoQueue: 'true',
                ContentBasedDeduplication: 'true',
            },
        }));
        if (!deadLetter.QueueUrl) {
            throw new Error('LocalStack não retornou a URL da DLQ de teste.');
        }
        let primaryQueueUrl: string | undefined;
        let consumer: WagerTransactionConsumer | undefined;
        try {
            const deadLetterAttributes = await sqs.send(new GetQueueAttributesCommand({
                QueueUrl: deadLetter.QueueUrl,
                AttributeNames: ['QueueArn'],
            }));
            const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
            if (!deadLetterArn) {
                throw new Error('LocalStack não retornou o ARN da DLQ de teste.');
            }
            const primary = await sqs.send(new CreateQueueCommand({
                QueueName: `wager-test-primary-${suffix}.fifo`,
                Attributes: {
                    FifoQueue: 'true',
                    ContentBasedDeduplication: 'true',
                    VisibilityTimeout: '1',
                    RedrivePolicy: JSON.stringify({
                        deadLetterTargetArn: deadLetterArn,
                        maxReceiveCount: '2',
                    }),
                },
            }));
            if (!primary.QueueUrl) {
                throw new Error('LocalStack não retornou a URL da fila primária de teste.');
            }
            primaryQueueUrl = primary.QueueUrl;
            const consumerConfig = {
                get: (key: string, fallback?: string) => {
                    const values: Record<string, string> = {
                        SQS_CONSUMER_ENABLED: 'true',
                        SQS_QUEUE_URL: primaryQueueUrl!,
                        SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
                        SQS_ENDPOINT: 'http://localhost:4566',
                        AWS_REGION: 'us-east-1',
                        AWS_ACCESS_KEY_ID: 'test',
                        AWS_SECRET_ACCESS_KEY: 'test',
                    };
                    return values[key] ?? fallback;
                },
                getOrThrow: (key: string) => {
                    if (key === 'SQS_QUEUE_URL') {
                        return primaryQueueUrl!;
                    }
                    throw new Error(`Configuração inesperada: ${key}`);
                },
            };
            consumer = new WagerTransactionConsumer(
                consumerConfig as unknown as ConfigService,
                app.get(ProcessWagerTransaction),
            );
            consumer.onModuleInit();
            const invalidBody = JSON.stringify({
                messageId: `invalid-${suffix}`,
                type: 'InvalidMessageForDlqTest',
            });
            await sqs.send(new SendMessageCommand({
                QueueUrl: primaryQueueUrl,
                MessageBody: invalidBody,
                MessageGroupId: 'dlq-test',
                MessageDeduplicationId: suffix,
            }));
            let deadLetterMessage: { Body?: string } | undefined;
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline && !deadLetterMessage) {
                const deadLetterMessages = await sqs.send(new ReceiveMessageCommand({
                    QueueUrl: deadLetter.QueueUrl,
                    MaxNumberOfMessages: 1,
                    WaitTimeSeconds: 1,
                    VisibilityTimeout: 0,
                }));
                deadLetterMessage = deadLetterMessages.Messages?.[0];
            }
            expect(deadLetterMessage?.Body).toBe(invalidBody);
        }
        finally {
            await consumer?.onModuleDestroy();
            if (primaryQueueUrl) {
                await sqs.send(new DeleteQueueCommand({
                    QueueUrl: primaryQueueUrl,
                }));
            }
            await sqs.send(new DeleteQueueCommand({
                QueueUrl: deadLetter.QueueUrl,
            }));
        }
    }, 45000);
});
