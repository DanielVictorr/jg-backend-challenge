import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction.js';
import { parseWagerTransactionMessage } from '../../../src/infrastructure/sqs/wager-transaction-message.js';
import { LedgerEntryEntity } from '../../../src/database/entities/ledger-entry.entity.js';
import { WalletEntity } from '../../../src/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../../src/database/entities/wager-transaction.entity.js';
type WorkerInput =
    | {
          mode: 'execute';
          input: Parameters<ProcessWagerTransaction['execute']>[0];
      }
    | {
          mode: 'receive-and-process-without-ack';
          queueUrl: string;
      }
    | {
          mode: 'receive-process-and-hold';
          queueUrl: string;
      };
const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 55432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE ?? 'jg_backend_integration',
    entities: [WalletEntity, LedgerEntryEntity, WagerTransactionEntity],
    synchronize: false,
    migrationsRun: false,
});
async function run(): Promise<void> {
    const serializedInput = process.argv[2];
    if (!serializedInput) {
        throw new Error('Parâmetros do processo de integração ausentes.');
    }
    const input = JSON.parse(serializedInput) as WorkerInput;
    await dataSource.initialize();
    const processor = new ProcessWagerTransaction(dataSource);
    if (input.mode === 'execute') {
        const result = await processor.execute(input.input);
        process.stdout.write(JSON.stringify(result));
        await dataSource.destroy();
        return;
    }
    const sqs = new SQSClient({
        endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        region: process.env.AWS_REGION ?? 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        },
    });
    const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: input.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: input.mode === 'receive-process-and-hold' ? 1 : 60,
    }));
    const message = response.Messages?.[0];
    if (!message?.Body || !message.ReceiptHandle) {
        throw new Error('O processo não recebeu a mensagem SQS esperada.');
    }
    const parsed = parseWagerTransactionMessage(message.Body);
    const result = await processor.execute(parsed.input, {
        consumerName: 'wager-transaction-consumer',
        messageId: parsed.messageId,
        payloadHash: parsed.payloadHash,
    });
    const output = JSON.stringify({
        result,
        receiptHandle: message.ReceiptHandle,
    });
    if (input.mode === 'receive-process-and-hold') {
        process.stdout.write(`${output}\n`);
        setInterval(() => undefined, 1000);
        return;
    }
    process.stdout.write(`${output}\n`, () => process.exit(0));
}
run().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(message);
    if (dataSource.isInitialized) {
        await dataSource.destroy();
    }
    process.exitCode = 1;
});
