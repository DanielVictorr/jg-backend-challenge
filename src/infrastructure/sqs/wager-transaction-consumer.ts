import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import { ConfigService } from '@nestjs/config';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { HttpException } from '@nestjs/common';

import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import { parseWagerTransactionMessage } from './wager-transaction-message.js';

const CONSUMER_NAME = 'wager-transaction-consumer';
const MAX_MESSAGES = 10;
const WAIT_TIME_SECONDS = 20;
const VISIBILITY_TIMEOUT_SECONDS = 60;

@Injectable()
export class WagerTransactionConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly enabled: boolean;

  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private readonly receiveAbortController = new AbortController();

  constructor(
    private readonly config: ConfigService,
    private readonly processor: ProcessWagerTransaction,
    @Optional() private readonly tracerService?: TracerService,
  ) {
    this.enabled =
      this.config.get<string>('SQS_CONSUMER_ENABLED', 'false') === 'true';

    this.queueUrl = this.enabled
      ? this.config.getOrThrow<string>('SQS_QUEUE_URL')
      : this.config.get<string>('SQS_QUEUE_URL', '');

    this.client = new SQSClient({
      region: this.config.get<string>('AWS_REGION', 'us-east-1'),
      endpoint: this.config.get<string>('SQS_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>(
          'AWS_ACCESS_KEY_ID',
          'test',
        ),
        secretAccessKey: this.config.get<string>(
          'AWS_SECRET_ACCESS_KEY',
          'test',
        ),
      },
    });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Consumidor SQS desabilitado; defina SQS_CONSUMER_ENABLED=true para ativá-lo.',
      );
      return;
    }

    this.logger.log('Consumidor SQS iniciado.');
    this.loopPromise = this.consumeLoop();
  }


    async onModuleDestroy(): Promise<void> {
      this.stopping = true;
      this.receiveAbortController.abort();

      try {
        await this.loopPromise;
      } finally {
        this.client.destroy();
        this.logger.log('Consumidor SQS encerrado.');
      }
    }


  private async consumeLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: MAX_MESSAGES,
            WaitTimeSeconds: WAIT_TIME_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          }),
          { abortSignal: this.receiveAbortController.signal },
        );

        
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
            this.logger.error(
              'Mensagem SQS sem Body ou ReceiptHandle; será deixada para nova tentativa.',
            );
            continue;
          }

          await this.processMessage(message.Body, message.ReceiptHandle);
        }


      } catch (error) {
        if (this.stopping) {
          break;
        }

        this.logger.error(
          'Falha ao consultar ou processar mensagens SQS.',
          error instanceof Error ? error.stack : String(error),
        );

        await this.delay(1_000);
      }
    }
  }

  private recordCounter(name: string, description: string): void {
    try {
      this.tracerService
        ?.counter(name, { description })
        .increment();
    } catch {
      
    }
  }  

  
  private async processMessage(
    body: string,
    receiptHandle: string,
  ): Promise<void> {
    let parsed: ReturnType<typeof parseWagerTransactionMessage>;

    try {
      parsed = parseWagerTransactionMessage(body);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        this.recordCounter(
          'wager_messages_left_for_dlq_redrive_total',
          'Mensagens inválidas deixadas na fila para possível redrive à DLQ.',
        );

        this.logger.warn(
          'Mensagem SQS inválida; será deixada para redrive à DLQ.',
        );
        return;
      }

      this.logger.error(
        'Falha inesperada ao interpretar mensagem SQS; será tentada novamente.',
      );
      return;
    }

    try {
      const result = await this.processor.execute(parsed.input, {
        consumerName: CONSUMER_NAME,
        messageId: parsed.messageId,
        payloadHash: parsed.payloadHash,
      });

      await this.deleteMessage(receiptHandle);

      if ('duplicateMessage' in result) {
        this.logger.log(
          `Mensagem duplicada já processada pelo Inbox: ${parsed.messageId}`,
        );
      } else {
        this.logger.log(
          `Mensagem SQS processada: transactionId=${result.transactionId}, status=${result.status}`,
        );
      }
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        this.logger.warn(
          'Mensagem SQS rejeitada por erro terminal.',
        );

        await this.deleteMessage(receiptHandle);
        return;
      }

      this.recordCounter(
        'wager_sqs_processing_retries_total',
        'Falhas transitórias no processamento SQS que permitem nova tentativa.',
      );

      this.logger.error(
        'Falha transitória ao processar mensagem SQS; será tentada novamente.',
      );
    }
  }



  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  
  private async returnMessageToQueue(
    receiptHandle: string | undefined,
  ): Promise<void> {
    if (!receiptHandle) {
      return;
    }

    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );

      this.logger.log(
        'Mensagem pendente devolvida à fila durante o encerramento.',
      );
    } catch (error) {
      this.logger.error(
        'Não foi possível devolver a mensagem à fila; ela poderá ser redeliverada quando a visibilidade expirar.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }


  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
