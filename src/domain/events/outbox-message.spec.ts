
import { describe, expect, it } from 'vitest';
import { OutboxMessage } from './outbox-message.js';

describe('OutboxMessage', () => {
  const occurredAt = new Date('2026-01-01T12:00:00.000Z');

  function createMessage() {
    return OutboxMessage.enqueue({
      eventId: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      occurredAt,
      data: { amount: '100.00' },
    });
  }

  it('creates a pending message ready at its occurrence date', () => {
    const message = createMessage();

    expect(message.id).toBe('event-1');
    expect(message.isPending()).toBe(true);
    expect(message.isDue(occurredAt)).toBe(true);
    expect(message.attempts).toBe(0);
  });

  it('schedules retries with exponential backoff', () => {
    const message = createMessage();

    message.scheduleRetry(occurredAt);

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt.getTime() - occurredAt.getTime())
      .toBe(1_000);
    expect(message.isDue(occurredAt)).toBe(false);
  });

  it('caps retry delay at 15 minutes', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-2',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: {},
      occurredAt,
      attempts: 10,
      nextAttemptAt: occurredAt,
    });

    message.scheduleRetry(occurredAt);

    expect(message.nextAttemptAt.getTime() - occurredAt.getTime())
      .toBe(15 * 60 * 1_000);
  });

  it('marks a pending message as published', () => {
    const message = createMessage();
    const publishedAt = new Date('2026-01-01T12:01:00.000Z');

    message.markPublished(publishedAt);

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(publishedAt);
    expect(message.isDue(new Date('2026-01-01T13:00:00.000Z')))
      .toBe(false);
  });

  it('does not allow retry after publication', () => {
    const message = createMessage();
    message.markPublished(occurredAt);

    expect(() => message.scheduleRetry(occurredAt))
      .toThrow('Cannot retry a published outbox message');
  });

  it('rehydrates persisted retry metadata', () => {
    const nextAttemptAt = new Date('2026-01-01T12:00:05.000Z');

    const message = OutboxMessage.rehydrate({
      id: 'event-3',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { amount: '10.00' },
      occurredAt,
      attempts: 2,
      nextAttemptAt,
    });

    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(nextAttemptAt);
  });
});
