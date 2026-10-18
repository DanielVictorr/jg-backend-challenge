import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { TracerService } from '@nestjs/observe';
import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
import { LedgerEntry } from '../../domain/ledger/ledger-entry.js';

import {
  calculateWagerPayloadHash,
  type WagerBusinessPayload,
} from './canonical-payload.js';

export interface ProcessWagerTransactionInput extends WagerBusinessPayload {
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

export interface InboxMessageContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface InboxDuplicateResult {
  duplicateMessage: true;
}


@Injectable()
export class ProcessWagerTransaction {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly tracerService?: TracerService,
  ) {}

  
private recordLockConflict(): void {
  try {
    this.tracerService
      ?.counter('wager_lock_conflicts_total', {
        description:
          'Total de conflitos de bloqueio ou serialização no PostgreSQL.',
      })
      .increment();
  } catch {
    // Falhas de telemetria não podem afetar o processamento financeiro.
  }
}


  private recordProcessingLatency(durationMs: number): void {
    if (!this.tracerService || !Number.isFinite(durationMs)) {
      return;
    }

    try {
      this.tracerService
        .summary('wager_transaction_processing_duration_ms', {
          description:
            'Duração do processamento de transações, em milissegundos.',
        })
        .observe(durationMs);
    } catch {
    
    }
  }

  private recordMetrics(
    outcome: ProcessWagerTransactionOutput | InboxDuplicateResult,
  ): void {
    if (!this.tracerService) {
      return;
    }

    try {
      if ('duplicateMessage' in outcome) {
        this.tracerService
          .counter('wager_duplicate_messages_total', {
            description:
              'Total de mensagens duplicadas identificadas pela Inbox.',
          })
          .increment();

        return;
      }

      if (outcome.idempotentReplay) {
        this.tracerService
          .counter('wager_idempotent_replays_total', {
            description: 'Total de respostas idempotentes reutilizadas.',
          })
          .increment();

        return;
      }

      const validStatuses = Object.values(WagerTransactionStatus);

      if (
        !validStatuses.includes(
          outcome.status as WagerTransactionStatus,
        )
      ) {
        return;
      }

      this.tracerService
        .counter<'status'>('wager_transactions_total', {
          description: 'Total de novas transações persistidas por estado.',
          labels: ['status'],
        })
        .increment({
          status: outcome.status as WagerTransactionStatus,
        });
    } catch {
      
    }
  }

    async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionOutput>;

  async execute(
    input: ProcessWagerTransactionInput,
    inboxContext: InboxMessageContext,
  ): Promise<ProcessWagerTransactionOutput | InboxDuplicateResult>;

  async execute(
    input: ProcessWagerTransactionInput,
    inboxContext?: InboxMessageContext,
  ): Promise<ProcessWagerTransactionOutput | InboxDuplicateResult> {
    const startedAt = Date.now();
    this.validateInput(input);

    if (inboxContext) {
      if (
        typeof inboxContext.consumerName !== 'string' ||
        !inboxContext.consumerName.trim() ||
        inboxContext.consumerName.length > 100 ||
        typeof inboxContext.messageId !== 'string' ||
        !inboxContext.messageId.trim() ||
        inboxContext.messageId.length > 255 ||
        typeof inboxContext.payloadHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(inboxContext.payloadHash)
      ) {
        throw new BadRequestException({
          code: 'INVALID_INBOX_CONTEXT',
          message: 'O contexto da mensagem recebida é inválido.',
        });
      }
    }

    if (
      input.kind !== WagerTransactionKind.Bet &&
      input.kind !== WagerTransactionKind.Win &&
      input.kind !== WagerTransactionKind.Loss &&
      input.kind !== WagerTransactionKind.Refund &&
      input.kind !== WagerTransactionKind.Rollback
    ) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_TRANSACTION_KIND',
        message:
          'OPENING é uma operação interna. Tipo de transação não suportado.',
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
      const outcome = await this.dataSource.transaction<
          ProcessWagerTransactionOutput | InboxDuplicateResult
        >(async (manager) => {


        const markInboxProcessed = async (): Promise<void> => {
          if (!inboxContext) {
            return;
          }

          await manager.query(
            `UPDATE processed_messages
                SET processed_at = NOW()
              WHERE consumer_name = $1
                AND message_id = $2
                AND processed_at IS NULL`,
            [inboxContext.consumerName, inboxContext.messageId],
          );
        };


        if (inboxContext) {
  const insertedRows: Array<{ message_id: string }> =
    await manager.query(
      `INSERT INTO processed_messages
        (consumer_name, message_id, payload_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        inboxContext.consumerName,
        inboxContext.messageId,
        inboxContext.payloadHash,
      ],
    );

  if (insertedRows.length === 0) {
    const existingRows: Array<{
      payload_hash: string | null;
      processed_at: Date | string | null;
    }> = await manager.query(
      `SELECT payload_hash, processed_at
        FROM processed_messages
        WHERE consumer_name = $1
          AND message_id = $2`,
      [inboxContext.consumerName, inboxContext.messageId],
    );

    const existingInbox = existingRows[0];

    if (!existingInbox || !existingInbox.payload_hash) {
      throw new ConflictException({
        code: 'INBOX_PAYLOAD_HASH_UNAVAILABLE',
        message:
          'A mensagem já existe no Inbox, mas não possui hash verificável.',
      });
    }

    if (existingInbox.payload_hash !== inboxContext.payloadHash) {
      throw new ConflictException({
        code: 'INBOX_MESSAGE_ID_REUSED',
        message:
          'O messageId já foi utilizado com um conteúdo diferente.',
      });
    }

    if (existingInbox.processed_at === null) {
      throw new InternalServerErrorException({
        code: 'INBOX_MESSAGE_NOT_COMPLETED',
        message:
          'A mensagem existe no Inbox, mas seu processamento ainda não foi confirmado.',
      });
    }

    return { duplicateMessage: true };
  }
}

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

        const transactionRepository = manager.getRepository(
          WagerTransactionEntity,
        );

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
              message: 'A transação existente não possui resultado armazenado.',
            });
          }

          await markInboxProcessed();

          return {
            ...(existing.responseSnapshot as unknown as ProcessWagerTransactionOutput),
            idempotentReplay: true,
          };
        }

        // A identidade externa também precisa ser única,
        // mesmo quando o cliente usa outra chave de idempotência.
        const existingExternal = await transactionRepository.findOne({
          where: {
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          },
        });

        if (existingExternal) {
          throw new ConflictException({
            code: 'EXTERNAL_TRANSACTION_ALREADY_EXISTS',
            message: 'Já existe uma transação com esse identificador externo.',
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
        let pendingReference = false;
        let referenceTransactionId: string | null = null;
        let referenceEntity: WagerTransactionEntity | null = null;

        if (money.currency !== wallet.balance.currency) {
          failureCode = FailureCode.InvalidTransaction;
        } else if (
          input.kind === WagerTransactionKind.Refund ||
          input.kind === WagerTransactionKind.Rollback
        ) {
          referenceEntity =
            (await transactionRepository.findOne({
              where: {
                providerId: input.providerId,
                externalTransactionId: input.referenceExternalTransactionId!,
              },
            })) ?? null;

          if (!referenceEntity) {
            transaction.markPendingReference();
            pendingReference = true;
          } else {
            const referenceKind = referenceEntity.kind;
            const isValidReferenceKind =
              input.kind === WagerTransactionKind.Refund
                ? referenceKind === WagerTransactionKind.Bet
                : referenceKind === WagerTransactionKind.Bet ||
                  referenceKind === WagerTransactionKind.Win ||
                  referenceKind === WagerTransactionKind.Refund;

            const isValidReferenceContext =
              referenceEntity.status === WagerTransactionStatus.Processed &&
              referenceEntity.playerId === input.playerId &&
              referenceEntity.walletId === input.walletId &&
              referenceEntity.roundId === input.roundId &&
              referenceEntity.currency === money.currency;

            if (!isValidReferenceKind || !isValidReferenceContext) {
              failureCode = FailureCode.InvalidReference;
            } else {
              const referenceMoney = Money.from({
                amount: referenceEntity.amount,
                currency: referenceEntity.currency,
              });

              if (!money.equals(referenceMoney)) {
                failureCode = FailureCode.ReferenceAmountMismatch;
              } else {
                const existingReversal = await transactionRepository.findOne({
                  where: {
                    providerId: input.providerId,
                    referenceTransactionId: referenceEntity.id,
                    kind: input.kind as WagerTransactionKind,
                    status: WagerTransactionStatus.Processed,
                  },
                });

                if (existingReversal) {
                  failureCode = FailureCode.ReferenceAlreadyReversed;
                } else {
                  try {
                    if (input.kind === WagerTransactionKind.Refund) {
                      wallet.credit(money);
                    } else if (referenceKind === WagerTransactionKind.Bet) {
                      wallet.credit(money);
                    } else {
                      wallet.debit(money);
                    }

                    referenceTransactionId = referenceEntity.id;
                  } catch (error) {
                    if (
                      error instanceof Error &&
                      error.message === 'Insufficient wallet balance'
                    ) {
                      failureCode =
                        FailureCode.ReversalWouldCauseNegativeBalance;
                    } else {
                      throw error;
                    }
                  }
                }
              }
            }
          }
        } else if (input.kind === WagerTransactionKind.Bet) {
          try {
            wallet.debit(money);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'Insufficient wallet balance'
            ) {
              failureCode = FailureCode.InsufficientFunds;
            } else {
              throw error;
            }
          }
        } else if (input.kind === WagerTransactionKind.Win) {
          wallet.credit(money);
        }

        // Rejeições são terminais. Uma referência ausente permanece pendente.
        if (failureCode) {
          transaction.reject(failureCode);
        } else if (!pendingReference) {
          transaction.markProcessed(
            referenceTransactionId ?? undefined,
            new Date(),
          );
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
        const referenceNextRetryAt = pendingReference
          ? new Date(Date.now() + 5_000)
          : null;

        const referenceExpiresAt = pendingReference
          ? new Date(transaction.createdAt.getTime() + 24 * 60 * 60 * 1_000)
          : null;

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
            referenceTransactionId,
            failureCode: transaction.failureCode ?? null,
            responseSnapshot: { ...result },
            processedAt: transaction.processedAt ?? null,
            referenceRetryCount: 0,
            referenceNextRetryAt,
            referenceExpiresAt,

          }),
        );

        const balanceChanged = !balanceBefore.equals(balanceAfter);

        if (balanceChanged) {
          await manager.getRepository(WalletEntity).update(walletEntity.id, {
            balance: balanceAfter.toJSON().amount,
            version: wallet.version,
          });

          const ledgerType =
            input.kind === WagerTransactionKind.Bet ||
            (input.kind === WagerTransactionKind.Rollback &&
              referenceEntity?.kind !== WagerTransactionKind.Bet)
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
            correlationId: transaction.id,
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
        const eventType = pendingReference
          ? 'WagerTransactionPendingReference'
          : failureCode
            ? 'WagerTransactionRejected'
            : 'WagerTransactionProcessed';

        const transactionEvent = {
            eventId: transactionEventId,
            eventType,
            aggregateId: wallet.id,
            correlationId: transaction.id,
            occurredAt: new Date().toISOString(),
            version: 1,
            data: {
            transactionId: transaction.id,
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: transaction.kind,
            status: transaction.status,
            ...(failureCode ? { failureCode } : {}),
            ...(transaction.referenceExternalTransactionId
              ? {
                  referenceExternalTransactionId:
                    transaction.referenceExternalTransactionId,
                }
              : {}),
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

                await markInboxProcessed();
        return result;
      });

      this.recordMetrics(outcome);
      this.recordProcessingLatency(Date.now() - startedAt);
      return outcome;
    } catch (error) { 
      this.recordProcessingLatency(Date.now() - startedAt);
      
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as {
          code?: string;
          constraint?: string;
        };
        if (
          driverError.code === '40P01' ||
          driverError.code === '55P03' ||
          driverError.code === '40001'
        ) {
          this.recordLockConflict();
        }

        if (
          driverError.code === '23505' &&
          driverError.constraint === 'uq_wagering_provider_idempotency'
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

            if (!existing.responseSnapshot) {
              throw new ConflictException({
                code: 'TRANSACTION_RESULT_UNAVAILABLE',
                message: 'A transação existente não possui resultado armazenado.',
              });
            }

            if (existing.responseSnapshot) {
              const response = {
                ...(existing.responseSnapshot as unknown as ProcessWagerTransactionOutput),
                idempotentReplay: true,
              };

              if (!inboxContext) {
                this.recordMetrics(response);
                return response;
              }

              const outcome = await this.dataSource.transaction<
                ProcessWagerTransactionOutput | InboxDuplicateResult
              >(async (manager) => {
                const insertedRows: Array<{ message_id: string }> =
                  await manager.query(
                    `INSERT INTO processed_messages
                      (consumer_name, message_id, payload_hash)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (consumer_name, message_id) DO NOTHING
                    RETURNING message_id`,
                    [
                      inboxContext.consumerName,
                      inboxContext.messageId,
                      inboxContext.payloadHash,
                    ],
                  );



                if (insertedRows.length === 0) {
                  const existingRows: Array<{
                    payload_hash: string | null;
                    processed_at: Date | string | null;
                  }> = await manager.query(
                    `SELECT payload_hash, processed_at
                      FROM processed_messages
                      WHERE consumer_name = $1
                        AND message_id = $2`,
                    [inboxContext.consumerName, inboxContext.messageId],
                  );


                  const existingInbox = existingRows[0];

                  if (!existingInbox?.payload_hash) {
                    throw new ConflictException({
                      code: 'INBOX_PAYLOAD_HASH_UNAVAILABLE',
                      message: 'A mensagem existente não possui hash verificável.',
                    });
                  }

                  if (existingInbox.payload_hash !== inboxContext.payloadHash) {
                    throw new ConflictException({
                      code: 'INBOX_MESSAGE_ID_REUSED',
                      message: 'O messageId foi reutilizado com conteúdo diferente.',
                    });
                  }


                  if (existingInbox.processed_at === null) {
                    throw new InternalServerErrorException({
                      code: 'INBOX_MESSAGE_NOT_COMPLETED',
                      message:
                        'A mensagem existe no Inbox, mas seu processamento ainda não foi confirmado.',
                    });
                  }


                  return { duplicateMessage: true };
                }

                await manager.query(
                  `UPDATE processed_messages
                      SET processed_at = NOW()
                    WHERE consumer_name = $1
                      AND message_id = $2
                      AND processed_at IS NULL`,
                  [inboxContext.consumerName, inboxContext.messageId],
                );

                                return response;
              });

              this.recordMetrics(outcome);
              return outcome;
            }

          }
        }

        if (
          driverError.code === '23505' &&
          driverError.constraint === 'uq_wagering_provider_external_transaction'
        ) {
          throw new ConflictException({
            code: 'EXTERNAL_TRANSACTION_ALREADY_EXISTS',
            message: 'Já existe uma transação com esse identificador externo.',
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
      if (typeof input[field] !== 'string' || !input[field].trim()) {
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
      !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(input.money.amount) ||
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
