
import { Money } from '../money/money.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/**
 * Códigos estáveis para auditoria e comunicação com o provedor.
 * Não altere códigos já persistidos sem uma estratégia de compatibilidade.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InvalidTransaction = 'INVALID_TRANSACTION',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReversalWouldCauseNegativeBalance = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
  PermanentProcessingFailure = 'PERMANENT_PROCESSING_FAILURE',
}

export class InvalidTransactionStateError extends Error {
  constructor(message = 'Invalid wager transaction state transition') {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const VALID_KINDS = new Set<WagerTransactionKind>(
  Object.values(WagerTransactionKind),
);

const VALID_STATUSES = new Set<WagerTransactionStatus>(
  Object.values(WagerTransactionStatus),
);

const VALID_FAILURE_CODES = new Set<FailureCode>(
  Object.values(FailureCode),
);

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;

  private readonly createdAtValue: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;

  private constructor(
    props: CreateWagerTransactionProps,
    state?: {
      status: WagerTransactionStatus;
      referenceTransactionId?: string;
      failureCode?: FailureCode;
      processedAt?: Date;
    },
  ) {
    this.id = props.id;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.walletId = props.walletId;
    this.playerId = props.playerId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.money = props.money;
    this.referenceExternalTransactionId =
      props.referenceExternalTransactionId;

    this.createdAtValue = new Date(
      (props.createdAt ?? new Date()).getTime(),
    );

    this._status = state?.status ?? WagerTransactionStatus.Pending;
    this._referenceTransactionId = state?.referenceTransactionId;
    this._failureCode = state?.failureCode;
    this._processedAt = state?.processedAt
      ? new Date(state.processedAt.getTime())
      : undefined;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    this.validateProps(props);

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new Error(
        `${props.kind} requires a reference external transaction id`,
      );
    }

    if (
      props.referenceExternalTransactionId !== undefined &&
      !props.referenceExternalTransactionId.trim()
    ) {
      throw new Error('Reference external transaction id cannot be empty');
    }

    return new WagerTransaction(props);
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    this.validateProps(state);

    if (!VALID_STATUSES.has(state.status)) {
      throw new Error('Invalid wager transaction status');
    }

    if (
      state.referenceExternalTransactionId !== undefined &&
      !state.referenceExternalTransactionId.trim()
    ) {
      throw new Error('Reference external transaction id cannot be empty');
    }

    if (
      state.kind !== WagerTransactionKind.Refund &&
      state.kind !== WagerTransactionKind.Rollback &&
      state.referenceExternalTransactionId !== undefined
    ) {
      // Outros tipos podem referenciar uma BET, por exemplo WIN.
      // A referência externa é permitida nesses casos.
    }

    if (
      state.status === WagerTransactionStatus.Processed &&
      state.processedAt === undefined
    ) {
      throw new Error('Processed transaction requires processedAt');
    }

    if (
      state.status === WagerTransactionStatus.Rejected ||
      state.status === WagerTransactionStatus.Failed
    ) {
      if (
        state.failureCode === undefined ||
        !VALID_FAILURE_CODES.has(state.failureCode)
      ) {
        throw new Error('Rejected or failed transaction requires a valid failureCode');
      }
    } else if (state.failureCode !== undefined) {
      throw new Error('Non-terminal transaction cannot have a failureCode');
    }

    if (
      state.status !== WagerTransactionStatus.Processed &&
      state.processedAt !== undefined
    ) {
      throw new Error('Only processed transactions can have processedAt');
    }

    if (
      state.status === WagerTransactionStatus.Pending &&
      state.referenceTransactionId !== undefined
    ) {
      throw new Error('Pending transaction cannot have a resolved reference');
    }

    if (
      state.status === WagerTransactionStatus.PendingReference &&
      state.referenceTransactionId !== undefined
    ) {
      throw new Error(
        'Pending-reference transaction cannot have a resolved reference',
      );
    }

    if (
      state.referenceTransactionId !== undefined &&
      !state.referenceTransactionId.trim()
    ) {
      throw new Error('Resolved reference transaction id cannot be empty');
    }

    return new WagerTransaction(state, {
      status: state.status,
      referenceTransactionId: state.referenceTransactionId,
      failureCode: state.failureCode,
      processedAt: state.processedAt,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  /**
   * PENDING ou PENDING_REFERENCE -> PROCESSED.
   * Uma transação processada precisa ter um instante de processamento válido.
   */
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertNotTerminal();

    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error('Invalid processedAt date');
    }

    if (
      this.requiresReference() &&
      !referenceTransactionId?.trim()
    ) {
      throw new Error('Resolved reference transaction id is required');
    }

    if (
      referenceTransactionId !== undefined &&
      !referenceTransactionId.trim()
    ) {
      throw new Error('Resolved reference transaction id cannot be empty');
    }

    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
    this._failureCode = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  /**
   * PENDING -> PENDING_REFERENCE.
   * Chamar novamente neste estado é uma transição inválida.
   */
  markPendingReference(): void {
    this.assertNotTerminal();

    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        'Only pending transactions can await a reference',
      );
    }

    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        'This transaction kind does not require a reference',
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  /** PENDING ou PENDING_REFERENCE -> REJECTED. */
  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this.assertValidFailureCode(code);

    this._failureCode = code;
    this._processedAt = undefined;
    this._status = WagerTransactionStatus.Rejected;
  }

  /** PENDING ou PENDING_REFERENCE -> FAILED. */
  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this.assertValidFailureCode(code);

    this._failureCode = code;
    this._processedAt = undefined;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /**
   * LOSS registra um resultado sem movimentar o saldo.
   * OPENING movimenta o saldo, mas só deve ser usado internamente.
   */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Determina a direção do ledger quando a operação realmente movimenta saldo.
   * LOSS não possui lançamento; ROLLBACK inverte a direção da referência.
   */
  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not produce a ledger entry');

      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new Error('ROLLBACK requires a referenced transaction');
        }

        if (reference.kind === WagerTransactionKind.Loss) {
          throw new Error('Cannot derive ledger direction from LOSS');
        }

        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;

      default: {
        const exhaustiveCheck: never = this.kind;
        throw new Error( 
          `Unsupported transaction kind: ${String(exhaustiveCheck)}`,
        );
      }
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition terminal transaction from ${this._status}`,
      );
    }
  }

  private assertValidFailureCode(code: FailureCode): void {
    if (!VALID_FAILURE_CODES.has(code)) {
      throw new Error('Invalid failure code');
    }
  }

  private static validateProps(
    props: CreateWagerTransactionProps,
  ): void {
    if (!props || typeof props !== 'object') {
      throw new Error('Wager transaction properties are required');
    }

    const requiredFields: Array<keyof CreateWagerTransactionProps> = [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ];

    for (const field of requiredFields) {
      const value = props[field];

      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} is required`);
      }
    }

    if (!VALID_KINDS.has(props.kind)) {
      throw new Error('Invalid wager transaction kind');
    }

    if (!(props.money instanceof Money)) {
      throw new Error('Wager transaction money is required');
    }

    if (props.money.isZero() || props.money.isNegative()) {
      throw new Error('Wager transaction amount must be positive');
    }

    if (
      props.createdAt !== undefined &&
      (!(props.createdAt instanceof Date) ||
        Number.isNaN(props.createdAt.getTime()))
    ) {
      throw new Error('Invalid createdAt date');
    }
  }
}