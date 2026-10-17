
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wagering/wager-transaction.js';

import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: {
    amount: string;
    currency: string;
  };
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

@Injectable()
export class CreateWallet {
  constructor(private readonly dataSource: DataSource) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    this.validateInput(input);

    let initialBalance: Money;

    try {
      initialBalance = Money.from(input.initialBalance);
    } catch {
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message: 'O valor ou a moeda informados são inválidos.',
      });
    }

    const playerId = input.playerId.trim();
    const walletId = randomUUID();
    const now = new Date();

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
    });

    try {
      return await this.dataSource.transaction(async (manager) => {
        const walletRepository = manager.getRepository(WalletEntity);

        const walletEntity = walletRepository.create({
          id: wallet.id,
          playerId: wallet.playerId,
          currency: initialBalance.currency,
          balance: initialBalance.toJSON().amount,
          version: wallet.version,
        });

        await walletRepository.save(walletEntity);

        // Saldo inicial zero não gera OPENING nem lançamento.
        if (initialBalance.isPositive()) {
          const transactionId = randomUUID();
          const ledgerEntryId = randomUUID();

          // Identidade reservada exclusivamente para operações internas.
          const providerId = '__internal__';
          const externalTransactionId = `wallet-opening:${walletId}`;
          const idempotencyKey = `wallet-opening:${walletId}`;
          const roundId = '__wallet_opening__';
          const gameId = '__internal__';

          // As propriedades têm ordem fixa para gerar um hash estável.
          const payloadHash = createHash('sha256')
            .update(
              JSON.stringify({
                walletId,
                playerId,
                kind: WagerTransactionKind.Opening,
                money: initialBalance.toJSON(),
              }),
            )
            .digest('hex');

          const opening = WagerTransaction.create({
            id: transactionId,
            providerId,
            externalTransactionId,
            idempotencyKey,
            payloadHash,
            walletId,
            playerId,
            roundId,
            gameId,
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: now,
          });

          opening.markProcessed(undefined, now);

          const transactionRepository =
            manager.getRepository(WagerTransactionEntity);

          await transactionRepository.save(
            transactionRepository.create({
              id: opening.id,
              walletId: opening.walletId,
              playerId: opening.playerId,
              providerId: opening.providerId,
              externalTransactionId: opening.externalTransactionId,
              idempotencyKey: opening.idempotencyKey,
              payloadHash: opening.payloadHash,
              roundId: opening.roundId,
              gameId: opening.gameId,
              kind: opening.kind,
              status: opening.status,
              amount: initialBalance.toJSON().amount,
              currency: initialBalance.currency,
              referenceExternalTransactionId: null,
              referenceTransactionId: null,
              failureCode: null,
              responseSnapshot: {
                transactionId,
                status: opening.status,
                balance: initialBalance.toJSON(),
                idempotentReplay: false,
              },
              processedAt: opening.processedAt,
            }),
          );

          const zeroBalance = Money.zero(initialBalance.currency);

          const ledgerEntry = manager
            .getRepository(LedgerEntryEntity)
            .create({
              id: ledgerEntryId,
              walletId,
              transactionId,
              entryType: 'CREDIT',
              amount: initialBalance.toJSON().amount,
              currency: initialBalance.currency,
              balanceBefore: zeroBalance.toJSON().amount,
              balanceAfter: initialBalance.toJSON().amount,
            });

          await manager
            .getRepository(LedgerEntryEntity)
            .save(ledgerEntry);

          // Os eventos são gravados na mesma transação SQL.
          // Um publisher poderá enviá-los após o commit.
          const balanceChangedEventId = randomUUID();
          const transactionProcessedEventId = randomUUID();

          const balanceChangedPayload = {
            eventId: balanceChangedEventId,
            eventType: 'WalletBalanceChanged',
            aggregateId: walletId,
            correlationId: walletId,
            occurredAt: now.toISOString(),
            version: 1,
            data: {
              walletId,
              transactionId,
              direction: 'CREDIT',
              money: initialBalance.toJSON(),
              balanceBefore: zeroBalance.toJSON(),
              balanceAfter: initialBalance.toJSON(),
              walletVersion: wallet.version,
            },
          };

          const transactionProcessedPayload = {
            eventId: transactionProcessedEventId,
            eventType: 'WagerTransactionProcessed',
            aggregateId: walletId,
            correlationId: walletId,
            occurredAt: now.toISOString(),
            version: 1,
            data: {
              transactionId,
              walletId,
              playerId,
              kind: opening.kind,
              status: opening.status,
              money: initialBalance.toJSON(),
            },
          };

          await manager.query(
            `INSERT INTO outbox_events
              (id, aggregate_type, aggregate_id, event_type, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              balanceChangedEventId,
              'Wallet',
              walletId,
              'WalletBalanceChanged',
              JSON.stringify(balanceChangedPayload),
            ],
          );

          await manager.query(
            `INSERT INTO outbox_events
              (id, aggregate_type, aggregate_id, event_type, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              transactionProcessedEventId,
              'Wallet',
              walletId,
              'WagerTransactionProcessed',
              JSON.stringify(transactionProcessedPayload),
            ],
          );
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: initialBalance.toJSON(),
          version: wallet.version,
        };
      });
    
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as {
          code?: string;
          constraint?: string;
        };

        if (
          driverError.code === '23505' &&
          driverError.constraint === 'uq_wallets_player_currency'
        ) {
          throw new ConflictException({
            code: 'WALLET_ALREADY_EXISTS',
            message: 'Já existe uma carteira para este jogador e moeda.',
          });
        }
      }

      throw error;
    }

  }

  private validateInput(input: CreateWalletInput): void {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('O corpo da requisição é obrigatório.');
    }

    if (
      typeof input.playerId !== 'string' ||
      !input.playerId.trim() ||
      input.playerId.trim().length > 100
    ) {
      throw new BadRequestException({
        code: 'INVALID_PLAYER_ID',
        message: 'playerId deve ser uma string não vazia de até 100 caracteres.',
      });
    }

    if (
      !input.initialBalance ||
      typeof input.initialBalance !== 'object' ||
      typeof input.initialBalance.amount !== 'string' ||
      typeof input.initialBalance.currency !== 'string'
    ) {
      throw new BadRequestException({
        code: 'INVALID_INITIAL_BALANCE',
        message: 'initialBalance deve conter amount e currency como strings.',
      });
    }

    // NUMERIC(20,2): até 18 dígitos inteiros e 2 casas decimais.
    if (
      !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(
        input.initialBalance.amount,
      )
    ) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: 'amount deve ser decimal não negativo com até 2 casas decimais.',
      });
    }

    if (!/^[A-Z]{3}$/.test(input.initialBalance.currency)) {
      throw new BadRequestException({
        code: 'INVALID_CURRENCY',
        message: 'currency deve ser um código de 3 letras maiúsculas.',
      });
    }
  }
}
