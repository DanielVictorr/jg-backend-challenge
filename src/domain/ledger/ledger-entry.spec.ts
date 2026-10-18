import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import { LedgerEntry } from './ledger-entry.js';
describe('LedgerEntry', () => {
    const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
    const validEntry = () => ({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        type: 'DEBIT' as const,
        amount: money('10.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('90.00'),
        createdAt: new Date('2025-01-15T12:00:00.000Z'),
    });
    it('creates a valid debit entry', () => {
        const entry = LedgerEntry.create(validEntry());
        expect(entry.type).toBe('DEBIT');
        expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
        expect(entry.balanceAfter.toJSON().amount).toBe('90.00');
        expect(entry.isBalanced()).toBe(true);
    });
    it('creates a valid credit entry', () => {
        const entry = LedgerEntry.create({
            ...validEntry(),
            type: 'CREDIT',
            balanceBefore: money('100.00'),
            balanceAfter: money('110.00'),
        });
        expect(entry.type).toBe('CREDIT');
        expect(entry.isBalanced()).toBe(true);
    });
    it('rejects a zero amount', () => {
        expect(() => LedgerEntry.create({
            ...validEntry(),
            amount: money('0.00'),
        })).toThrow('Ledger entry amount must be positive');
    });
    it('rejects an invalid entry type', () => {
        expect(() => LedgerEntry.create({
            ...validEntry(),
            type: 'INVALID' as 'DEBIT',
        })).toThrow('Invalid ledger entry type');
    });
    it('rejects an empty entry id', () => {
        expect(() => LedgerEntry.create({ ...validEntry(), id: '' })).toThrow('Ledger entry id is required');
    });
    it('rejects an empty wallet id', () => {
        expect(() => LedgerEntry.create({ ...validEntry(), walletId: '' })).toThrow('Wallet id is required');
    });
    it('rejects an incorrect resulting balance', () => {
        expect(() => LedgerEntry.create({
            ...validEntry(),
            balanceAfter: money('95.00'),
        })).toThrow('Ledger entry balance is inconsistent');
    });
    it('rejects a debit that would make the balance negative', () => {
        expect(() => LedgerEntry.create({
            ...validEntry(),
            balanceBefore: money('5.00'),
            balanceAfter: money('5.00').negate(),
        })).toThrow('Ledger debit cannot produce a negative balance');
    });
    it('rejects different currencies', () => {
        expect(() => LedgerEntry.create({
            ...validEntry(),
            balanceAfter: Money.from({
                amount: '90.00',
                currency: 'USD',
            }),
        })).toThrow('Currency mismatch');
    });
    it('rehydrates a persisted entry', () => {
        const entry = LedgerEntry.rehydrate(validEntry());
        expect(entry.id).toBe('ledger-1');
        expect(entry.isBalanced()).toBe(true);
    });
    it('does not expose a mutable creation date', () => {
        const entry = LedgerEntry.create(validEntry());
        const date = entry.createdAt;
        date.setFullYear(2000);
        expect(entry.createdAt.getFullYear()).toBe(2025);
    });
    it('freezes the ledger entry structure', () => {
        const entry = LedgerEntry.create(validEntry());
        expect(Object.isFrozen(entry)).toBe(true);
        expect(() => {
            Object.assign(entry, { type: 'CREDIT' });
        }).toThrow();
    });
    it('does not allow changing the original creation date', () => {
        const originalDate = new Date('2025-01-15T12:00:00.000Z');
        const entry = LedgerEntry.create({
            ...validEntry(),
            createdAt: originalDate,
        });
        originalDate.setFullYear(2000);
        expect(entry.createdAt.getFullYear()).toBe(2025);
    });
    it('rejects a persisted entry with an invalid balance snapshot', () => {
        const state = {
            ...validEntry(),
            balanceBefore: Money.from({
                amount: '100.00',
                currency: 'BRL',
            }),
            amount: Money.from({
                amount: '20.00',
                currency: 'BRL',
            }),
            balanceAfter: Money.from({
                amount: '90.00',
                currency: 'BRL',
            }),
            createdAt: new Date('2025-01-15T12:00:00.000Z'),
        };
        expect(() => LedgerEntry.rehydrate(state)).toThrow();
    });
});
