
import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  it('creates money with exactly two decimal places', () => {
    const money = Money.from({ amount: '10.5', currency: 'BRL' });

    expect(money.toJSON()).toEqual({
      amount: '10.50',
      currency: 'BRL',
    });
  });

  it('creates zero for a currency', () => {
    const money = Money.zero('BRL');

    expect(money.isZero()).toBe(true);
    expect(money.toJSON().amount).toBe('0.00');
  });

  it('adds decimal amounts exactly', () => {
    const first = Money.from({ amount: '0.10', currency: 'BRL' });
    const second = Money.from({ amount: '0.20', currency: 'BRL' });

    expect(first.add(second).toJSON().amount).toBe('0.30');
  });

  it('subtracts amounts', () => {
    const balance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wager = Money.from({ amount: '35.75', currency: 'BRL' });

    expect(balance.subtract(wager).toJSON().amount).toBe('64.25');
  });

  it('negates a value', () => {
    const money = Money.from({ amount: '10.00', currency: 'BRL' });
    const negative = money.negate();

    expect(negative.toJSON().amount).toBe('-10.00');
    expect(negative.isNegative()).toBe(true);
  });

  it('compares values', () => {
    const first = Money.from({ amount: '10.00', currency: 'BRL' });
    const second = Money.from({ amount: '10.01', currency: 'BRL' });

    expect(first.isLessThan(second)).toBe(true);
    expect(first.equals(second)).toBe(false);
    expect(first.isPositive()).toBe(true);
  });

  it('rejects invalid input amounts', () => {
    const invalidAmounts = [
      '',
      'NaN',
      'Infinity',
      '-10.00',
      '1e3',
      '10.999',
      ' 10.00',
    ];

    for (const amount of invalidAmounts) {
      expect(() =>
        Money.from({ amount, currency: 'BRL' }),
      ).toThrow();
    }
  });

  it('rejects arithmetic with different currencies', () => {
    const reais = Money.from({ amount: '10.00', currency: 'BRL' });
    const dollars = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => reais.add(dollars)).toThrow('Currency mismatch');
    expect(() => reais.subtract(dollars)).toThrow('Currency mismatch');
  });

  it('formats values using two decimal places', () => {
    const money = Money.from({ amount: '25', currency: 'BRL' });

    expect(money.toString()).toBe('25.00 BRL');
  });
  
  it('freezes the money instance', () => {
    const money = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    expect(Object.isFrozen(money)).toBe(true);

    expect(() => {
      Object.assign(money, { currency: 'USD' });
    }).toThrow();
  });

});
