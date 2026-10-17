
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wagering/wager-transaction.js';

import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
import { LedgerEntry } from '../../domain/ledger/ledger-entry.js';

import {
  calculateWagerPayloadHash,
  type WagerBusinessPayload,
} from './canonical-payload.js';

export interface ProcessWagerTransactionInput
  extends WagerBusinessPayload {
  idempotencyKey: string;
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  walletId: string;
  status: string;
  kind: string;
  balance: {
    amount: string;
    currency: string;
  };
  failureCode?: string;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransaction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionOutput> {
    this.validateInput(input);

    if (
      input.kind !== WagerTransactionKind.Bet &&
      input.kind !== WagerTransactionKind.Win &&
      input.kind !== WagerTransactionKind.Loss
    ) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_TRANSACTION_KIND',
        message:
          'Esta versão aceita somente BET, WIN e LOSS.',
      });
    }

    let money: Money;

    try {
      money = Money.from(input.money);
    } catch {
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message: 'O valor ou a moeda informados são inválidos.',
      });
    }

    const payloadHash = calculateWagerPayloadHash(input);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Serializa somente operações sobre esta carteira.
        const lockedWallets = await manager.query(
          `SELECT id
             FROM wallets
            WHERE id = $1
            FOR UPDATE`,
          [input.walletId],
        );

        if (lockedWallets.length === 0) {
          throw new NotFoundException({
            code: 'WALLET_NOT_FOUND',
            message: 'Carteira não encontrada.',
          });
        }

        const transactionRepository =
          manager.getRepository(WagerTransactionEntity);

        // Verifica a idempotência depois de obter o bloqueio da carteira.
        const existing = await transactionRepository.findOne({
          where: {
            providerId: input.providerId,
            idempotencyKey: input.idempotencyKey,
          },
        });

        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message:
                'A chave de idempotência já foi usada com outro conteúdo.',
            });
          }

          if (!existing.responseSnapshot) {
            throw new ConflictException({
              code: 'TRANSACTION_RESULT_UNAVAILABLE',
              message:
                'A transação existente não possui resultado armazenado.',
            });
          }

          return {
            ...(existing.responseSnapshot as unknown as
              ProcessWagerTransactionOutput),
            idempotentReplay: true,
          };
        }

        // A identidade externa também precisa ser única,
        // mesmo quando o cliente usa outra chave de idempotência.
        const existingExternal =
          await transactionRepository.findOne({
            where: {
              providerId: input.providerId,
              externalTransactionId: input.externalTransactionId,
            },
          });

        if (existingExternal) {
          throw new ConflictException({
            code: 'EXTERNAL_TRANSACTION_ALREADY_EXISTS',
            message:
              'Já existe uma transação com esse identificador externo.',
          });
        }

        const walletEntity = await manager
          .getRepository(WalletEntity)
          .findOneByOrFail({ id: input.walletId });

        if (walletEntity.playerId !== input.playerId) {
          throw new BadRequestException({
            code: 'PLAYER_WALLET_MISMATCH',
            message: 'A carteira não pertence ao jogador informado.',
          });
        }

        const wallet = Wallet.rehydrate({
          id: walletEntity.id,
          playerId: walletEntity.playerId,
          balance: Money.from({
            amount: walletEntity.balance,
            currency: walletEntity.currency,
          }),
          version: walletEntity.version,
          updatedAt: walletEntity.updatedAt,
        });

        const transaction = WagerTransaction.create({
          id: randomUUID(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind as WagerTransactionKind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: new Date(),
        });

        const balanceBefore = wallet.balance;
        let failureCode: FailureCode | undefined;

        if (money.currency !== wallet.balance.currency) {
          failureCode = FailureCode.InvalidTransaction;
          transaction.reject(failureCode);
        } else if (input.kind === WagerTransactionKind.Bet) {
          try {
            wallet.debit(money);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'Insufficient wallet balance'
            ) {
              failureCode = FailureCode.InsufficientFunds;
              transaction.reject(failureCode);
            } else {
              throw error;
            }
          }
        } else if (input.kind === WagerTransactionKind.Win) {
          wallet.credit(money);
        }

        // LOSS não altera o saldo e não gera lançamento contábil.
        if (!failureCode) {
          transaction.markProcessed(undefined, new Date());
        }

        const balanceAfter = wallet.balance;
        const result: ProcessWagerTransactionOutput = {
          transactionId: transaction.id,
          walletId: wallet.id,
          status: transaction.status,
          kind: transaction.kind,
          balance: balanceAfter.toJSON(),
          ...(failureCode ? { failureCode } : {}),
          idempotentReplay: false,
        };

        await transactionRepository.save(
          transactionRepository.create({
            id: transaction.id,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            status: transaction.status,
            amount: money.toJSON().amount,
            currency: money.currency,
            referenceExternalTransactionId:
            transaction.referenceExternalTransactionId ?? null,
            referenceTransactionId: null,
            failureCode: transaction.failureCode ?? null,
            responseSnapshot: { ...result },
            processedAt: transaction.processedAt ?? null,
          }),
        );

        const balanceChanged = !balanceBefore.equals(balanceAfter);

        if (balanceChanged) {
          await manager.getRepository(WalletEntity).update(walletEntity.id, {
            balance: balanceAfter.toJSON().amount,
            version: wallet.version,
          });

          const ledgerType =
            input.kind === WagerTransactionKind.Bet
              ? 'DEBIT'
              : 'CREDIT';

          const ledgerEntry = LedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            type: ledgerType,
            amount: money,
            balanceBefore,
            balanceAfter,
          });

            const ledgerRepository = manager.getRepository(LedgerEntryEntity);

          await ledgerRepository.save(
            ledgerRepository.create({
              id: ledgerEntry.id,
              walletId: ledgerEntry.walletId,
              transactionId: ledgerEntry.transactionId,
              entryType: ledgerEntry.type,
              amount: ledgerEntry.amount.toJSON().amount,
              currency: ledgerEntry.amount.currency,
              balanceBefore: ledgerEntry.balanceBefore.toJSON().amount,
              balanceAfter: ledgerEntry.balanceAfter.toJSON().amount,
              createdAt: ledgerEntry.createdAt,
            }),
          );

          const balanceEventId = randomUUID();

          const balanceEvent = {
            eventId: balanceEventId,
            eventType: 'WalletBalanceChanged',
            aggregateId: wallet.id,
            occurredAt: new Date().toISOString(),
            version: 1,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: ledgerType,
              money: money.toJSON(),
              balanceBefore: balanceBefore.toJSON(),
              balanceAfter: balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          };

          await manager.query(
            `INSERT INTO outbox_events
              (id, aggregate_type, aggregate_id, event_type, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              balanceEventId,
              'Wallet',
              wallet.id,
              'WalletBalanceChanged',
              JSON.stringify(balanceEvent),
            ],
          );
        }

        const transactionEventId = randomUUID();
        const eventType = failureCode
          ? 'WagerTransactionRejected'
          : 'WagerTransactionProcessed';

        const transactionEvent = {
          eventId: transactionEventId,
          eventType,
          aggregateId: wallet.id,
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {
            transactionId: transaction.id,
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: transaction.kind,
            status: transaction.status,
            ...(failureCode ? { failureCode } : {}),
          },
        };

        await manager.query(
          `INSERT INTO outbox_events
            (id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            transactionEventId,
            'Wallet',
            wallet.id,
            eventType,
            JSON.stringify(transactionEvent),
          ],
        );

        return result;
      });
    } catch (error) {
      // Duas requisições simultâneas podem competir por um índice único.
      // Não convertemos qualquer violação de unicidade em repetição.
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as {
          code?: string;
          constraint?: string;
        };

        if (
          driverError.code === '23505' &&
          driverError.constraint ===
            'uq_wagering_provider_idempotency'
        ) {
          const existing = await this.dataSource
            .getRepository(WagerTransactionEntity)
            .findOne({
              where: {
                providerId: input.providerId,
                idempotencyKey: input.idempotencyKey,
              },
            });

          if (existing) {
            if (existing.payloadHash !== payloadHash) {
              throw new ConflictException({
                code: 'IDEMPOTENCY_KEY_REUSED',
                message:
                  'A chave de idempotência já foi usada com outro conteúdo.',
              });
            }

            if (existing.responseSnapshot) {
              return {
                ...(existing.responseSnapshot as unknown as
                  ProcessWagerTransactionOutput),
                idempotentReplay: true,
              };
            }
          }
        }

        if (
          driverError.code === '23505' &&
          driverError.constraint ===
            'uq_wagering_provider_external_transaction'
        ) {
          throw new ConflictException({
            code: 'EXTERNAL_TRANSACTION_ALREADY_EXISTS',
            message:
              'Já existe uma transação com esse identificador externo.',
          });
        }
      }

      throw error;
    }
  }

  private validateInput(input: ProcessWagerTransactionInput): void {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'O corpo da requisição é obrigatório.',
      });
    }

    const requiredStrings = [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
    ] as const;

    for (const field of requiredStrings) {
      if (
        typeof input[field] !== 'string' ||
        !input[field].trim()
      ) {
        throw new BadRequestException({
          code: 'INVALID_REQUEST',
          message: `${field} é obrigatório.`,
        });
      }
    }

    if (
      input.providerId.length > 100 ||
      input.externalTransactionId.length > 255 ||
      input.idempotencyKey.length > 255 ||
      input.playerId.length > 100 ||
      input.roundId.length > 255 ||
      input.gameId.length > 255
    ) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'Um ou mais campos excedem o tamanho permitido.',
      });
    }

    if (
      !input.money ||
      typeof input.money.amount !== 'string' ||
      !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(
        input.money.amount,
      ) ||
      typeof input.money.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(input.money.currency)
    ) {
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message:
          'money deve conter amount decimal e currency com três letras maiúsculas.',
      });
    }

    if (
      input.money.amount === '0' ||
      /^0(?:\.0{1,2})?$/.test(input.money.amount)
    ) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: 'O valor da transação deve ser maior que zero.',
      });
    }
  }
}
