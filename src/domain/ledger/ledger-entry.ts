import { Money } from '../money/money.js';

export type LedgerEntryType = 'CREDIT' | 'DEBIT';

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  type: LedgerEntryType;
  amount: Money;
  createdAt?: Date;
}

export class LedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly type: LedgerEntryType;
  public readonly amount: Money;

  private readonly createdAtValue: Date;

  private constructor(props: LedgerEntryProps) {
    if (!props.id.trim()) {
      throw new Error('Ledger entry id is required');
    }

    if (!props.walletId.trim()) {
      throw new Error('Wallet id is required');
    }

    if (!props.transactionId.trim()) {
      throw new Error('Transaction id is required');
    }

    const zero = Money.zero(props.amount.currency);

    if (props.amount.equals(zero) || props.amount.isNegative()) {
      throw new Error('Ledger entry amount must be positive');
    }

    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.type = props.type;
    this.amount = props.amount;

    const date = props.createdAt ?? new Date();
    this.createdAtValue = new Date(date.getTime());

    Object.freeze(this);
  }

  static create(props: LedgerEntryProps): LedgerEntry {
    if (props.type !== 'CREDIT' && props.type !== 'DEBIT') {
      throw new Error('Invalid ledger entry type');
    }

    return new LedgerEntry(props);
  }

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }
}