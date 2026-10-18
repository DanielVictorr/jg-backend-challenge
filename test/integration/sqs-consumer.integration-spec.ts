import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient, } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { WalletEntity } from '../../src/database/entities/wallet.entity.js';
describe('SQS Consumer — integração real', () => {
    let app: INestApplication;
    let sqs: SQSClient;
    let dataSource: DataSource;
    let createWallet: CreateWallet;
    let queueUrl: string;
    const originalEnv = {
        SQS_CONSUMER_ENABLED: process.env.SQS_CONSUMER_ENABLED,
        SQS_QUEUE_URL: process.env.SQS_QUEUE_URL,
        SQS_ENDPOINT: process.env.SQS_ENDPOINT,
        OUTBOX_PUBLISHER_ENABLED: process.env.OUTBOX_PUBLISHER_ENABLED,
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
});
