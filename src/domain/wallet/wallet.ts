import { Money } from '../money/money.js';
export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
}
export interface WalletState {
    id: string;
    playerId: string;
    balance: Money;
    version: number;
    updatedAt: Date;
}
export class Wallet {
    private balanceValue: Money;
    private versionValue: number;
    private updatedAtValue: Date;
    private constructor(public readonly id: string, public readonly playerId: string, balance: Money, version: number, updatedAt: Date) {
        this.balanceValue = balance;
        this.versionValue = version;
        this.updatedAtValue = new Date(updatedAt.getTime());
    }
    static open(props: OpenWalletProps): Wallet {
        if (!props.id.trim()) {
            throw new Error('Wallet id is required');
        }
        if (!props.playerId.trim()) {
            throw new Error('Player id is required');
        }
        if (props.initialBalance.isNegative()) {
            throw new Error('Initial balance cannot be negative');
        }
        return new Wallet(props.id, props.playerId, props.initialBalance, 1, new Date());
    }
    static rehydrate(state: WalletState): Wallet {
        if (!state || typeof state !== 'object') {
            throw new Error('Wallet state is required');
        }
        if (typeof state.id !== 'string' || !state.id.trim()) {
            throw new Error('Wallet id is required');
        }
        if (typeof state.playerId !== 'string' ||
            !state.playerId.trim()) {
            throw new Error('Player id is required');
        }
        if (!(state.balance instanceof Money)) {
            throw new Error('Wallet balance is required');
        }
        if (state.balance.isNegative()) {
            throw new Error('Wallet balance cannot be negative');
        }
        if (!Number.isInteger(state.version) || state.version < 1) {
            throw new Error('Wallet version must be an integer greater than zero');
        }
        if (!(state.updatedAt instanceof Date) ||
            Number.isNaN(state.updatedAt.getTime())) {
            throw new Error('Invalid wallet updatedAt date');
        }
        return new Wallet(state.id, state.playerId, state.balance, state.version, state.updatedAt);
    }
    get balance(): Money {
        return this.balanceValue;
    }
    get version(): number {
        return this.versionValue;
    }
    get updatedAt(): Date {
        return new Date(this.updatedAtValue.getTime());
    }
    debit(amount: Money): void {
        this.assertPositiveAmount(amount);
        const newBalance = this.balanceValue.subtract(amount);
        if (newBalance.isNegative()) {
            throw new Error('Insufficient wallet balance');
        }
        this.changeBalance(newBalance);
    }
    credit(amount: Money): void {
        this.assertPositiveAmount(amount);
        const newBalance = this.balanceValue.add(amount);
        this.changeBalance(newBalance);
    }
    private assertPositiveAmount(amount: Money): void {
        if (amount.isZero() || amount.isNegative()) {
            throw new Error('Amount must be positive');
        }
        if (amount.currency !== this.balanceValue.currency) {
            throw new Error('Currency mismatch');
        }
    }
    private changeBalance(newBalance: Money): void {
        if (this.balanceValue.equals(newBalance)) {
            return;
        }
        this.balanceValue = newBalance;
        this.versionValue += 1;
        this.updatedAtValue = new Date();
    }
}
