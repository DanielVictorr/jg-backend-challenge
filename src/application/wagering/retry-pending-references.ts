
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';

import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
import { LedgerEntry } from '../../domain/ledger/ledger-entry.js';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 100;
const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_SECONDS = 900;
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1_000;

interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

@Injectable()
export class RetryPendingReferences
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RetryPendingReferences.name);

  private interval: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.runSafely();
    }, POLL_INTERVAL_MS);

    void this.runSafely();
  }

  onModuleDestroy(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /**
   * Método público para executar o worker de forma determinística
   * nos testes de integração.
   */
  async processDueReferences(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const candidates =
        await this.dataSource.query<PendingReferenceCandidate[]>(
          `
            SELECT
              id,
              wallet_id AS "walletId"
            FROM wagering_transactions
            WHERE status = 'PENDING_REFERENCE'
              AND (
                reference_next_retry_at <= NOW()
                OR reference_expires_at <= NOW()
              )
            ORDER BY reference_next_retry_at NULLS FIRST, created_at
            LIMIT $1
          `,
          [BATCH_SIZE],
        );

      for (const candidate of candidates) {
        try {
          await this.processCandidate(candidate);
        } catch (error) {
          this.logger.error(
            `Falha ao processar a transação pendente ${candidate.id}.`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async processCandidate(
    candidate: PendingReferenceCandidate,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      /*
       * A ordem dos bloqueios é importante:
       * primeiro carteira, depois transação.
       * É a mesma ordem utilizada pelo serviço principal.
       */
      const lockedWallets: Array<{ id: string }> = await manager.query(
        `
          SELECT id
          FROM wallets
          WHERE id = $1
          FOR UPDATE
        `,
        [candidate.walletId],
      );

      if (lockedWallets.length === 0) {
        this.logger.warn(
          `A carteira da transação ${candidate.id} não existe mais.`,
        );
        return;
      }

      
        
      const transactionRepository = manager.getRepository(
        WagerTransactionEntity,
      );

      const transaction = await transactionRepository.findOne({
        where: { id: candidate.id },
        lock: { mode: 'pessimistic_write' },
      });



      if (
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return;
      }

      const now = new Date();

      const nextRetryAt = transaction.referenceNextRetryAt
        ? new Date(transaction.referenceNextRetryAt)
        : null;

      const expiresAt = transaction.referenceExpiresAt
        ? new Date(transaction.referenceExpiresAt)
        : new Date(
            new Date(transaction.createdAt).getTime() + REFERENCE_TTL_MS,
          );

      /*
       * Outro worker pode ter processado a transação enquanto
       * aguardávamos os bloqueios. Revalidamos o prazo.
       */
      if (
        nextRetryAt &&
        nextRetryAt.getTime() > now.getTime() &&
        expiresAt.getTime() > now.getTime()
      ) {
        return;
      }

      const reference = await manager
        .getRepository(WagerTransactionEntity)
        .findOne({
          where: {
            providerId: transaction.providerId,
            externalTransactionId:
              transaction.referenceExternalTransactionId!,
          },
        });

      if (!reference) {
        await this.handleMissingReference(
          manager,
          transaction,
          now,
          expiresAt,
        );
        return;
      }

      await this.processResolvedReference(
        manager,
        transaction,
        reference,
      );
    });
  }

  private async handleMissingReference(
    manager: EntityManager,
    transaction: WagerTransactionEntity,
    now: Date,
    expiresAt: Date,
  ): Promise<void> {
    const retryCount = transaction.referenceRetryCount + 1;

    const exhausted =
      retryCount >= MAX_RETRIES || now.getTime() >= expiresAt.getTime();

    
  if (exhausted) {
    await this.rejectResolvedTransaction(
      manager,
      transaction,
      FailureCode.ReferenceNotFound,
      retryCount,
    );

    this.logger.warn(
      `Transação ${transaction.id} rejeitada: referência não encontrada.`,
    );

    return;
  }

    const delaySeconds = Math.min(
      5 * 2 ** (retryCount - 1),
      MAX_RETRY_DELAY_SECONDS,
    );

    const nextRetry = new Date(
      now.getTime() + delaySeconds * 1_000,
    );

    await manager
      .getRepository(WagerTransactionEntity)
      .update(transaction.id, {
        referenceRetryCount: retryCount,
        referenceNextRetryAt: nextRetry,
        referenceExpiresAt: expiresAt,
      });

    this.logger.debug(
      `Transação ${transaction.id}: tentativa ${retryCount}/${MAX_RETRIES}; ` +
        `próxima tentativa em ${delaySeconds}s.`,
    );
  }

  private async processResolvedReference(
    manager: EntityManager,
    transaction: WagerTransactionEntity,
    reference: WagerTransactionEntity,
  ): Promise<void> {
    const transactionRepository = manager.getRepository(
      WagerTransactionEntity,
    );

    const kind = transaction.kind as WagerTransactionKind;
    const referenceKind = reference.kind as WagerTransactionKind;

    const validReferenceKind =
      kind === WagerTransactionKind.Refund
        ? referenceKind === WagerTransactionKind.Bet
        : kind === WagerTransactionKind.Rollback &&
          (
            referenceKind === WagerTransactionKind.Bet ||
            referenceKind === WagerTransactionKind.Win ||
            referenceKind === WagerTransactionKind.Refund
          );

    const validReferenceContext =
      reference.status === WagerTransactionStatus.Processed &&
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.currency === transaction.currency;

    if (!validReferenceKind || !validReferenceContext) {
      await this.rejectResolvedTransaction(
        manager,
        transaction,
        FailureCode.InvalidReference,
      );
      return;
    }

    const amount = Money.from({
      amount: transaction.amount,
      currency: transaction.currency,
    });

    const referenceAmount = Money.from({
      amount: reference.amount,
      currency: reference.currency,
    });

    if (!amount.equals(referenceAmount)) {
      await this.rejectResolvedTransaction(
        manager,
        transaction,
        FailureCode.ReferenceAmountMismatch,
      );
      return;
    }

    const existingReversal = await transactionRepository.findOne({
      where: {
        providerId: transaction.providerId,
        referenceTransactionId: reference.id,
        kind,
        status: WagerTransactionStatus.Processed,
      },
    });

    if (existingReversal) {
      await this.rejectResolvedTransaction(
        manager,
        transaction,
        FailureCode.ReferenceAlreadyReversed,
      );
      return;
    }

    const walletEntity = await manager
      .getRepository(WalletEntity)
      .findOne({
        where: { id: transaction.walletId },
      });

    if (!walletEntity) {
      throw new Error(
        `Carteira ${transaction.walletId} não encontrada durante a retentativa.`,
      );
    }

    if (walletEntity.playerId !== transaction.playerId) {
      await this.rejectResolvedTransaction(
        manager,
        transaction,
        FailureCode.InvalidReference,
      );
      return;
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

    const balanceBefore = wallet.balance;

    /*
     * REFUND sempre credita.
     * ROLLBACK desfaz o efeito financeiro da referência:
     * BET -> crédito; WIN/REFUND -> débito.
     */
    const ledgerType: 'CREDIT' | 'DEBIT' =
      kind === WagerTransactionKind.Refund ||
      referenceKind === WagerTransactionKind.Bet
        ? 'CREDIT'
        : 'DEBIT';

    try {
      if (ledgerType === 'CREDIT') {
        wallet.credit(amount);
      } else {
        wallet.debit(amount);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Insufficient wallet balance'
      ) {
        await this.rejectResolvedTransaction(
          manager,
          transaction,
          FailureCode.ReversalWouldCauseNegativeBalance,
        );
        return;
      }

      throw error;
    }

    const balanceAfter = wallet.balance;

    const processedAt = new Date();

    const responseSnapshot = {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      status: WagerTransactionStatus.Processed,
      kind: transaction.kind,
      balance: balanceAfter.toJSON(),
      idempotentReplay: false,
    };

    await transactionRepository.update(transaction.id, {
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: reference.id,
      failureCode: null,
      processedAt,
      referenceNextRetryAt: null,
      responseSnapshot,
    });

    await manager.getRepository(WalletEntity).update(walletEntity.id, {
      balance: balanceAfter.toJSON().amount,
      version: wallet.version,
    });

    const ledgerEntry = LedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      type: ledgerType,
      amount,
      balanceBefore,
      balanceAfter,
    });

    await manager.getRepository(LedgerEntryEntity).save(
      manager.getRepository(LedgerEntryEntity).create({
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
        money: amount.toJSON(),
        balanceBefore: balanceBefore.toJSON(),
        balanceAfter: balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    };

    await this.insertOutboxEvent(
      manager,
      balanceEventId,
      wallet.id,
      'WalletBalanceChanged',
      balanceEvent,
    );

    await this.insertTransactionEvent(
      manager,
      transaction,
      'WagerTransactionProcessed',
      WagerTransactionStatus.Processed,
      undefined,
    );
  }

  
  private async rejectResolvedTransaction(
    manager: EntityManager,
    transaction: WagerTransactionEntity,
    failureCode: FailureCode,
    referenceRetryCount?: number,
  ): Promise<void> {
    const walletEntity = await manager
      .getRepository(WalletEntity)
      .findOneBy({ id: transaction.walletId });

    if (!walletEntity) {
      throw new Error(
        `Carteira ${transaction.walletId} não encontrada ao rejeitar transação ${transaction.id}.`,
      );
    }

    const responseSnapshot = {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      status: WagerTransactionStatus.Rejected,
      kind: transaction.kind,
      balance: {
        amount: walletEntity.balance,
        currency: walletEntity.currency,
      },
      failureCode,
      idempotentReplay: false,
    };

    await manager
      .getRepository(WagerTransactionEntity)
      .update(transaction.id, {
        status: WagerTransactionStatus.Rejected,
        failureCode,
        referenceNextRetryAt: null,
        responseSnapshot,
        ...(referenceRetryCount !== undefined
          ? { referenceRetryCount }
          : {}),
      });

    await this.insertTransactionEvent(
      manager,
      transaction,
      'WagerTransactionRejected',
      WagerTransactionStatus.Rejected,
      failureCode,
    );
  }


  private async insertTransactionEvent(
    manager: EntityManager,
    transaction: WagerTransactionEntity,
    eventType: string,
    status: WagerTransactionStatus,
    failureCode?: FailureCode,
  ): Promise<void> {
    const eventId = randomUUID();

    const event = {
      eventId,
      eventType,
      aggregateId: transaction.walletId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        status,
        ...(failureCode ? { failureCode } : {}),
        ...(transaction.referenceExternalTransactionId
          ? {
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId,
            }
          : {}),
      },
    };

    await this.insertOutboxEvent(
      manager,
      eventId,
      transaction.walletId,
      eventType,
      event,
    );
  }

  private async insertOutboxEvent(
    manager: EntityManager,
    eventId: string,
    walletId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO outbox_events
          (id, aggregate_type, aggregate_id, event_type, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        eventId,
        'Wallet',
        walletId,
        eventType,
        JSON.stringify(payload),
      ],
    );
  }

  private async runSafely(): Promise<void> {
    try {
      await this.processDueReferences();
    } catch (error) {
      this.logger.error(
        'Falha ao executar o worker de referências pendentes.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
