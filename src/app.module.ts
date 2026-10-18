import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createObserveModule } from '@nestjs/observe';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction.js';
import { WalletEntity } from './database/entities/wallet.entity.js';
import { LedgerEntryEntity } from './database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from './database/entities/wager-transaction.entity.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CreateWallet } from './application/wallet/create-wallet.js';
import { WalletsController } from './application/wallet/wallet.controller.js';
import { WageringController } from './application/wagering/wagering.controller.js';
import { GetWallet } from './application/wallet/get-wallet.js';
import { GetWalletLedger } from './application/wallet/get-wallet-ledger.js';
import { GetWagerTransaction } from './application/wagering/get-wager-transaction.js';
import { ProviderWageringTransactionsController } from './application/wagering/provider-wagering-transactions.controller.js';
import { RetryPendingReferences } from './application/wagering/retry-pending-references.js';
import { OutboxPublisher } from './infrastructure/outbox/outbox-publisher.js';
import { WagerTransactionConsumer } from './infrastructure/sqs/wager-transaction-consumer.js';
import { ReconcileWallet } from './application/wallet/reconcile-wallet.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('DB_HOST'),
        port: Number(config.getOrThrow<string>('DB_PORT')),
        username: config.getOrThrow<string>('DB_USERNAME'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        database: config.getOrThrow<string>('DB_DATABASE'),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
      }),
    }),

    TypeOrmModule.forFeature([
      WalletEntity,
      LedgerEntryEntity,
      WagerTransactionEntity,
    ]),

    ...(process.env.OBSERVE_APP_KEY?.trim() && 
        process.env.OBSERVE_APP_SECRET?.trim()
    ? [
      ObserveModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          appKey: config.getOrThrow<string>('OBSERVE_APP_KEY').trim(),
          appSecret: config
            .getOrThrow<string>('OBSERVE_APP_SECRET')
            .trim(),
          serviceId:
            config.get<string>('OBSERVE_SERVICE_ID')?.trim() ||
            'jg-backend-challenge',
        }),
      }),
    ]
  : []),
  ],
  controllers: [
    AppController,
    WalletsController,
    WageringController,
    ProviderWageringTransactionsController,
    HealthController,
  ],
  providers: [
  AppService,
  CreateWallet,
  ProcessWagerTransaction,
  GetWagerTransaction,
  GetWallet,
  GetWalletLedger,
  RetryPendingReferences,
  OutboxPublisher,
  WagerTransactionConsumer,
  ReconcileWallet,
  HealthService,
]
  
})
export class AppModule {}
