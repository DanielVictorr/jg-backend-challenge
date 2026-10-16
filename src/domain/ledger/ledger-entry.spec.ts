import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import { LedgerEntry } from './ledger-entry.js';

describe('LedgerEntry', () => {
  const validEntry = () => ({
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    type: 'DEBIT' as const,
    amount: Money.from({ amount: '10.00', currency: 'BRL' }),
    createdAt: new Date('2025-01-15T12:00:00.000Z'),
  });

  it('creates a valid debit entry', () => {
    const entry = LedgerEntry.create(validEntry());
    expect(entry.type).toBe('DEBIT');
    expect(entry.amount.toJSON()).toEqual({
      amount: '10.00',
      currency: 'BRL',
    });
  });

  it('creates a valid credit entry', () => {
    const entry = LedgerEntry.create({
      ...validEntry(),
      type: 'CREDIT',
    });
    expect(entry.type).toBe('CREDIT');
  });

  it('rejects a zero amount', () => {
    expect(() =>
      LedgerEntry.create({
        ...validEntry(),
        amount: Money.zero('BRL'),
      }),
    ).toThrow('Ledger entry amount must be positive');
  });

  it('rejects an invalid entry type', () => {
    expect(() =>
      LedgerEntry.create({
        ...validEntry(),
        type: 'INVALID' as 'DEBIT',
      }),
    ).toThrow('Invalid ledger entry type');
  });

  it('rejects an empty entry id', () => {
    expect(() =>
      LedgerEntry.create({ ...validEntry(), id: '' }),
    ).toThrow('Ledger entry id is required');
  });

  it('rejects an empty wallet id', () => {
    expect(() =>
      LedgerEntry.create({ ...validEntry(), walletId: '' }),
    ).toThrow('Wallet id is required');
  });

  it('does not expose a mutable creation date', () => {
    const entry = LedgerEntry.create(validEntry());
    const date = entry.createdAt;
    date.setFullYear(2000);
    expect(entry.createdAt.getFullYear()).toBe(2025);
  });
});