import { Money } from '../money/money.js';
import {
  FailureCode,
  InvalidTransactionStateError,
  LedgerDirection,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from './wager-transaction.js';

describe('WagerTransaction', () => {
  const createProps = (
    overrides: Partial<CreateWagerTransactionProps> = {},
  ): CreateWagerTransactionProps => {
    return {
      id: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'provider-1:external-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      ...overrides,
    };
  };

  const createState = (
    overrides: Partial<WagerTransactionState> = {},
  ): WagerTransactionState => {
    const base = createProps();
    const createdAt = overrides.createdAt ?? base.createdAt ?? new Date();

    return {
      ...base,
      status: WagerTransactionStatus.Pending,
      ...overrides,
      createdAt,
    };
  };

  describe('create', () => {
    it('creates a transaction in PENDING', () => {
      const transaction = WagerTransaction.create(createProps());

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
    });

    it('rejects an empty required identifier', () => {
      expect(() =>
        WagerTransaction.create(createProps({ walletId: ' ' })),
      ).toThrow('walletId is required');
    });

    it('rejects a zero amount', () => {
      expect(() =>
        WagerTransaction.create(
          createProps({
            money: Money.zero('BRL'),
          }),
        ),
      ).toThrow('Wager transaction amount must be positive');
    });

    it.each([
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ])('requires an external reference for %s', (kind) => {
      expect(() =>
        WagerTransaction.create(
          createProps({
            kind,
            referenceExternalTransactionId: undefined,
          }),
        ),
      ).toThrow('requires a reference external transaction id');
    });

    it('allows a reference for WIN', () => {
      const transaction = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Win,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      expect(transaction.kind).toBe(WagerTransactionKind.Win);
      expect(transaction.referenceExternalTransactionId).toBe(
        'external-bet-1',
      );
    });
  });

  describe('transitions', () => {
    it('marks a pending transaction as processed', () => {
      const transaction = WagerTransaction.create(createProps());
      const processedAt = new Date('2026-01-01T10:05:00.000Z');

      transaction.markProcessed(undefined, processedAt);

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.processedAt).toEqual(processedAt);
    });

    it('requires a resolved reference when processing a REFUND', () => {
      const transaction = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      expect(() =>
        transaction.markProcessed(undefined, new Date()),
      ).toThrow('Resolved reference transaction id is required');
    });

    it('processes a REFUND with its internal reference id', () => {
      const transaction = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      transaction.markProcessed(
        'internal-bet-1',
        new Date('2026-01-01T10:05:00.000Z'),
      );

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.referenceTransactionId).toBe('internal-bet-1');
    });

    it('moves a REFUND to PENDING_REFERENCE', () => {
      const transaction = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      transaction.markPendingReference();

      expect(transaction.status).toBe(
        WagerTransactionStatus.PendingReference,
      );
    });

    it('does not allow a BET to wait for a reference', () => {
      const transaction = WagerTransaction.create(createProps());

      expect(() => transaction.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('does not allow PENDING_REFERENCE to be assigned twice', () => {
      const transaction = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      transaction.markPendingReference();

      expect(() => transaction.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('rejects a transaction with a failure code', () => {
      const transaction = WagerTransaction.create(createProps());

      transaction.reject(FailureCode.InsufficientFunds);

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('fails a transaction with a failure code', () => {
      const transaction = WagerTransaction.create(createProps());

      transaction.fail(FailureCode.PermanentProcessingFailure);

      expect(transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction.failureCode).toBe(
        FailureCode.PermanentProcessingFailure,
      );
      expect(transaction.isTerminal()).toBe(true);
    });

    it.each([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ])('prevents transitions after terminal status %s', (status) => {
      const transaction = WagerTransaction.create(createProps());

      if (status === WagerTransactionStatus.Processed) {
        transaction.markProcessed(undefined, new Date());
      } else if (status === WagerTransactionStatus.Rejected) {
        transaction.reject(FailureCode.InvalidTransaction);
      } else {
        transaction.fail(FailureCode.PermanentProcessingFailure);
      }

      expect(() =>
        transaction.markProcessed(undefined, new Date()),
      ).toThrow(InvalidTransactionStateError);

      expect(() =>
        transaction.reject(FailureCode.InvalidTransaction),
      ).toThrow(InvalidTransactionStateError);

      expect(() =>
        transaction.fail(FailureCode.PermanentProcessingFailure),
      ).toThrow(InvalidTransactionStateError);

      expect(() => transaction.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('rejects an invalid processing date', () => {
      const transaction = WagerTransaction.create(createProps());

      expect(() =>
        transaction.markProcessed(undefined, new Date('invalid')),
      ).toThrow('Invalid processedAt date');
    });
  });

  describe('domain queries', () => {
    it('reports whether a transaction affects the balance', () => {
      const bet = WagerTransaction.create(createProps());
      const loss = WagerTransaction.create(
        createProps({
          id: 'transaction-loss',
          externalTransactionId: 'external-loss',
          idempotencyKey: 'provider-1:external-loss',
          kind: WagerTransactionKind.Loss,
        }),
      );

      expect(bet.affectsBalance()).toBe(true);
      expect(loss.affectsBalance()).toBe(false);
    });

    it('identifies kinds that require a reference', () => {
      const refund = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      const rollback = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      const bet = WagerTransaction.create(createProps());

      expect(refund.requiresReference()).toBe(true);
      expect(rollback.requiresReference()).toBe(true);
      expect(bet.requiresReference()).toBe(false);
    });

    it('matches an identical payload hash', () => {
      const transaction = WagerTransaction.create(createProps());

      expect(transaction.matchesPayload('hash-1')).toBe(true);
      expect(transaction.matchesPayload('different-hash')).toBe(false);
    });

    it.each([
      [WagerTransactionKind.Opening, LedgerDirection.Credit],
      [WagerTransactionKind.Bet, LedgerDirection.Debit],
      [WagerTransactionKind.Win, LedgerDirection.Credit],
      [WagerTransactionKind.Refund, LedgerDirection.Credit],
    ])('returns the expected ledger direction for %s', (kind, direction) => {
      const props = createProps({
        kind,
        ...(kind === WagerTransactionKind.Refund
          ? { referenceExternalTransactionId: 'external-bet-1' }
          : {}),
      });

      const transaction = WagerTransaction.create(props);

      expect(transaction.ledgerDirectionFor()).toBe(direction);
    });

    it('does not assign a ledger direction to LOSS', () => {
      const transaction = WagerTransaction.create(
        createProps({ kind: WagerTransactionKind.Loss }),
      );

      expect(() => transaction.ledgerDirectionFor()).toThrow(
        'LOSS does not produce a ledger entry',
      );
    });

    it('uses the inverse ledger direction for ROLLBACK', () => {
      const rollback = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      const bet = WagerTransaction.create(createProps());

      expect(rollback.ledgerDirectionFor(bet)).toBe(
        LedgerDirection.Credit,
      );
    });

    it('rejects ROLLBACK without its referenced transaction', () => {
      const rollback = WagerTransaction.create(
        createProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'external-bet-1',
        }),
      );

      expect(() => rollback.ledgerDirectionFor()).toThrow(
        'ROLLBACK requires a referenced transaction',
      );
    });
  });

  describe('rehydrate', () => {
    it('restores a processed transaction', () => {
      const createdAt = new Date('2026-01-01T10:00:00.000Z');
      const processedAt = new Date('2026-01-01T10:05:00.000Z');

      const transaction = WagerTransaction.rehydrate(
        createState({
          createdAt,
          status: WagerTransactionStatus.Processed,
          processedAt,
        }),
      );

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.processedAt).toEqual(processedAt);
    });

    it('requires a failure code for rejected transactions', () => {
      expect(() =>
        WagerTransaction.rehydrate(
          createState({
            status: WagerTransactionStatus.Rejected,
          }),
        ),
      ).toThrow(
        'Rejected or failed transaction requires a valid failureCode',
      );
    });

    it('requires processedAt for processed transactions', () => {
      expect(() =>
        WagerTransaction.rehydrate(
          createState({
            status: WagerTransactionStatus.Processed,
          }),
        ),
      ).toThrow('Processed transaction requires processedAt');
    });

    it('returns defensive copies of dates', () => {
      const createdAt = new Date('2026-01-01T10:00:00.000Z');
      const processedAt = new Date('2026-01-01T10:05:00.000Z');

      const transaction = WagerTransaction.rehydrate(
        createState({
          createdAt,
          status: WagerTransactionStatus.Processed,
          processedAt,
        }),
      );

      const returnedCreatedAt = transaction.createdAt;
      const returnedProcessedAt = transaction.processedAt;

      returnedCreatedAt.setFullYear(2000);
      returnedProcessedAt?.setFullYear(2000);

      expect(transaction.createdAt.getFullYear()).toBe(2026);
      expect(transaction.processedAt?.getFullYear()).toBe(2026);
    });
  });
});
