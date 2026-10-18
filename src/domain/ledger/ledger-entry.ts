import { Money } from '../money/money.js';
export type LedgerEntryType = 'CREDIT' | 'DEBIT';
export interface LedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    type: LedgerEntryType;
    amount: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt?: Date;
}
export interface LedgerEntryState extends LedgerEntryProps {
    createdAt: Date;
}
export class LedgerEntry {
    public readonly id: string;
    public readonly walletId: string;
    public readonly transactionId: string;
    public readonly type: LedgerEntryType;
    public readonly amount: Money;
    public readonly balanceBefore: Money;
    public readonly balanceAfter: Money;
    private readonly createdAtValue: Date;
    private constructor(props: LedgerEntryState) {
        this.id = props.id;
        this.walletId = props.walletId;
        this.transactionId = props.transactionId;
        this.type = props.type;
        this.amount = props.amount;
        this.balanceBefore = props.balanceBefore;
        this.balanceAfter = props.balanceAfter;
        this.createdAtValue = new Date(props.createdAt.getTime());
        Object.freeze(this);
    }
    static create(props: LedgerEntryProps): LedgerEntry {
        if (!props.id.trim()) {
            throw new Error('Ledger entry id is required');
        }
        if (!props.walletId.trim()) {
            throw new Error('Wallet id is required');
        }
        if (!props.transactionId.trim()) {
            throw new Error('Transaction id is required');
        }
        if (props.type !== 'CREDIT' && props.type !== 'DEBIT') {
            throw new Error('Invalid ledger entry type');
        }
        if (props.amount.isZero() || props.amount.isNegative()) {
            throw new Error('Ledger entry amount must be positive');
        }
        if (props.amount.currency !== props.balanceBefore.currency ||
            props.amount.currency !== props.balanceAfter.currency) {
            throw new Error('Currency mismatch');
        }
        const expectedBalance = props.type === 'CREDIT'
            ? props.balanceBefore.add(props.amount)
            : props.balanceBefore.subtract(props.amount);
        if (expectedBalance.isNegative()) {
            throw new Error('Ledger debit cannot produce a negative balance');
        }
        if (!expectedBalance.equals(props.balanceAfter)) {
            throw new Error('Ledger entry balance is inconsistent');
        }
        return new LedgerEntry({
            ...props,
            createdAt: props.createdAt ?? new Date(),
        });
    }
    static rehydrate(state: LedgerEntryState): LedgerEntry {
        return LedgerEntry.create(state);
    }
    isBalanced(): boolean {
        const expectedBalance = this.type === 'CREDIT'
            ? this.balanceBefore.add(this.amount)
            : this.balanceBefore.subtract(this.amount);
        return (!expectedBalance.isNegative() &&
            expectedBalance.equals(this.balanceAfter));
    }
    get createdAt(): Date {
        return new Date(this.createdAtValue.getTime());
    }
}
