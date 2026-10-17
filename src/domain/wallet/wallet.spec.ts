
import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import { Wallet } from './wallet.js';

describe('Wallet', () => {
  const money = (amount: string, currency = 'BRL') =>
    Money.from({ amount, currency });

  const openWallet = (initialBalance = '100.00') =>
    Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money(initialBalance),
    });

  it('opens a wallet with version 1', () => {
    const wallet = openWallet();

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('allows opening with zero balance', () => {
    const wallet = openWallet('0.00');

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      openWallet('-10.00'),
    ).toThrow();
  });

  it('debits the balance and increments the version', () => {
    const wallet = openWallet();

    wallet.debit(money('35.75'));

    expect(wallet.balance.toJSON().amount).toBe('64.25');
    expect(wallet.version).toBe(2);
  });

  it('credits the balance and increments the version', () => {
    const wallet = openWallet();

    wallet.credit(money('25.50'));

    expect(wallet.balance.toJSON().amount).toBe('125.50');
    expect(wallet.version).toBe(2);
  });

  it('allows a debit that leaves exactly zero', () => {
    const wallet = openWallet('100.00');

    wallet.debit(money('100.00'));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  it('rejects a debit that would make the balance negative', () => {
    const wallet = openWallet('100.00');

    expect(() => wallet.debit(money('100.01')))
      .toThrow('Insufficient wallet balance');

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects zero or negative operation amounts', () => {
    const wallet = openWallet();

    expect(() => wallet.debit(money('0.00'))).toThrow(
      'Amount must be positive',
    );

    expect(() => wallet.credit(money('0.00'))).toThrow(
      'Amount must be positive',
    );

    expect(() => wallet.debit(money('10.00').negate())).toThrow(
      'Amount must be positive',
    );
  });

  it('rejects operations in a different currency', () => {
    const wallet = openWallet();

    expect(() => wallet.debit(money('10.00', 'USD')))
      .toThrow('Currency mismatch');

    expect(() => wallet.credit(money('10.00', 'USD')))
      .toThrow('Currency mismatch');
  });

  it('rehydrates an existing wallet state', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-2',
      playerId: 'player-2',
      balance: money('75.25'),
      version: 8,
      updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    });

    expect(wallet.balance.toJSON().amount).toBe('75.25');
    expect(wallet.version).toBe(8);
    expect(wallet.id).toBe('wallet-2');
  });

  it('does not increment the version after a failed debit', () => {
    const wallet = openWallet('10.00');

    expect(() => wallet.debit(money('20.00'))).toThrow();

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
  });
    it('rejects a persisted wallet with an empty id', () => {
    expect(() =>
      Wallet.rehydrate({
        id: '',
        playerId: 'player-1',
        balance: money('100.00'),
        version: 1,
        updatedAt: new Date('2026-01-01T12:00:00.000Z'),
      }),
    ).toThrow('Wallet id is required');
  });

  it('rejects a persisted wallet with a negative balance', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        balance: money('10.00').negate(),
        version: 1,
        updatedAt: new Date('2026-01-01T12:00:00.000Z'),
      }),
    ).toThrow('Wallet balance cannot be negative');
  });

  it('rejects a persisted wallet with an invalid version', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        balance: money('100.00'),
        version: 0,
        updatedAt: new Date('2026-01-01T12:00:00.000Z'),
      }),
    ).toThrow('Wallet version must be an integer greater than zero');
  });

  it('rejects a persisted wallet with an invalid date', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        balance: money('100.00'),
        version: 1,
        updatedAt: new Date('invalid'),
      }),
    ).toThrow('Invalid wallet updatedAt date');
  });
});
