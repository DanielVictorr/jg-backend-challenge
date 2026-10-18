
import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.queueUrl = this.config.get<string>('SQS_QUEUE_URL', '');

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

  async checkReadiness(): Promise<{
    status: 'ok' | 'error';
    checks: {
      postgres: 'ok' | 'error';
      sqs: 'ok' | 'error';
    };
  }> {
    const [postgresResult, sqsResult] = await Promise.allSettled([
      this.dataSource.query('SELECT 1'),
      this.checkSqs(),
    ]);

    const postgres =
      postgresResult.status === 'fulfilled' ? 'ok' : 'error';

    const sqs = sqsResult.status === 'fulfilled' ? 'ok' : 'error';

    if (postgres === 'error' || sqs === 'error') {
      this.logger.warn(
        JSON.stringify({
          event: 'readiness_check_failed',
          postgres,
          sqs,
        }),
      );
    }

    return {
      status: postgres === 'ok' && sqs === 'ok' ? 'ok' : 'error',
      checks: {
        postgres,
        sqs,
      },
    };
  }

  private async checkSqs(): Promise<void> {
    if (!this.queueUrl) {
      throw new Error('SQS_QUEUE_URL não configurada');
    }

    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
