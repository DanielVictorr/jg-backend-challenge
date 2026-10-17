
import { describe, expect, it } from 'vitest';
import {
  calculateWagerPayloadHash,
  type WagerBusinessPayload,
} from './canonical-payload.js';

const payload: WagerBusinessPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: {
    amount: '25.00',
    currency: 'BRL',
  },
};

describe('calculateWagerPayloadHash', () => {
  it('returns the same hash for the same business payload', () => {
    expect(calculateWagerPayloadHash(payload)).toBe(
      calculateWagerPayloadHash({ ...payload }),
    );
  });

  it('returns the same hash regardless of object property order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(calculateWagerPayloadHash(payload)).toBe(
      calculateWagerPayloadHash(reordered),
    );
  });

  it('changes the hash when a business field changes', () => {
    expect(
      calculateWagerPayloadHash({
        ...payload,
        money: { amount: '26.00', currency: 'BRL' },
      }),
    ).not.toBe(calculateWagerPayloadHash(payload));
  });

  it('includes the reference transaction when supplied', () => {
    expect(
      calculateWagerPayloadHash({
        ...payload,
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-123',
      }),
    ).not.toBe(
      calculateWagerPayloadHash({
        ...payload,
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-456',
      }),
    );
  });

  it('returns a SHA-256 hexadecimal hash', () => {
    expect(calculateWagerPayloadHash(payload)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('normalizes equivalent monetary values before hashing', () => {
  const integerAmount = {
    ...payload,
    money: { amount: '25', currency: 'BRL' },
  };

  const decimalAmount = {
    ...payload,
    money: { amount: '25.00', currency: 'BRL' },
  };

  expect(calculateWagerPayloadHash(integerAmount)).toBe(
    calculateWagerPayloadHash(decimalAmount),
  );
  });
  
});
