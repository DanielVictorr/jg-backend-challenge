import { Decimal } from 'decimal.js';
export interface MoneyProps {
    amount: string;
    currency: string;
}
export class Money {
    private constructor(private readonly value: Decimal, public readonly currency: string) {
        if (!/^[A-Z]{3}$/.test(currency)) {
            throw new Error('Currency must be a 3-letter uppercase code');
        }
        Object.freeze(this);
    }
    static from(props: MoneyProps): Money {
        if (!props ||
            typeof props.amount !== 'string' ||
            !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(props.amount)) {
            throw new Error('Invalid decimal amount');
        }
        return new Money(new Decimal(props.amount), props.currency);
    }
    static zero(currency: string): Money {
        return new Money(new Decimal(0), currency);
    }
    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.plus(other.value), this.currency);
    }
    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.minus(other.value), this.currency);
    }
    negate(): Money {
        return new Money(this.value.negated(), this.currency);
    }
    isZero(): boolean {
        return this.value.isZero();
    }
    isPositive(): boolean {
        return this.value.greaterThan(0);
    }
    isNegative(): boolean {
        return this.value.isNegative();
    }
    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lessThan(other.value);
    }
    equals(other: Money): boolean {
        return (this.currency === other.currency &&
            this.value.equals(other.value));
    }
    toJSON(): MoneyProps {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }
    toString(): string {
        return `${this.value.toFixed(2)} ${this.currency}`;
    }
    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new Error('Currency mismatch');
        }
    }
}
