
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createObserveModule } from '@nestjs/observe';

import { WalletEntity } from './database/entities/wallet.entity.js';
import { LedgerEntryEntity } from './database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from './database/entities/wager-transaction.entity.js';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CreateWallet } from './application/wallet/create-wallet.js';
import { WalletsController } from './application/wallet/wallets.controller.js';

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

    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'jg-backend-challenge',
    }),
  ],
  controllers: [AppController, WalletsController],
  providers: [AppService, CreateWallet],
})
export class AppModule {}
