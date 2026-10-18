
export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts?: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

const MAX_RETRY_DELAY_MS = 15 * 60 * 1_000;

export class OutboxMessage {
  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt?: Date;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    attempts: number,
    nextAttemptAt: Date,
    publishedAt?: Date,
  ) {
    this._attempts = attempts;
    this._nextAttemptAt = new Date(nextAttemptAt);
    this._publishedAt = publishedAt
      ? new Date(publishedAt)
      : undefined;
  }

  static enqueue(
    event: {
      eventId: string;
      aggregateId: string;
      eventType: string;
      occurredAt: string | Date;
      toJSON?: () => Record<string, unknown>;
      [key: string]: unknown;
    },
  ): OutboxMessage {
    const payload =
      typeof event.toJSON === 'function'
        ? event.toJSON()
        : { ...event };

    const occurredAt =
      event.occurredAt instanceof Date
        ? event.occurredAt
        : new Date(event.occurredAt);

    return OutboxMessage.create({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      occurredAt,
      attempts: 0,
      nextAttemptAt: occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return OutboxMessage.create(state);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt
      ? new Date(this._publishedAt)
      : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date = new Date()): boolean {
    return (
      this.isPending() &&
      now.getTime() >= this._nextAttemptAt.getTime()
    );
  }

  markPublished(at: Date = new Date()): void {
    this.assertValidDate(at, 'Published date');

    if (!this.isPending()) {
      throw new Error('Outbox message is already published');
    }

    this._publishedAt = new Date(at);
  }

  scheduleRetry(now: Date = new Date()): void {
    this.assertValidDate(now, 'Retry date');

    if (!this.isPending()) {
      throw new Error('Cannot retry a published outbox message');
    }

    this._attempts += 1;

    const delayMs = Math.min(
      1_000 * 2 ** Math.min(this._attempts - 1, 30),
      MAX_RETRY_DELAY_MS,
    );

    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  private static create(
    props: OutboxMessageProps | OutboxMessageState,
  ): OutboxMessage {
    if (!props.id.trim()) {
      throw new Error('Outbox message id is required');
    }

    if (!props.aggregateId.trim()) {
      throw new Error('Outbox aggregate id is required');
    }

    if (!props.eventType.trim()) {
      throw new Error('Outbox event type is required');
    }

    if (!(props.occurredAt instanceof Date) ||
        Number.isNaN(props.occurredAt.getTime())) {
      throw new Error('Outbox occurredAt must be a valid date');
    }

    const attempts = props.attempts ?? 0;

    if (!Number.isInteger(attempts) || attempts < 0) {
      throw new Error('Outbox attempts must be a non-negative integer');
    }

    const nextAttemptAt = props.nextAttemptAt ?? props.occurredAt;

    if (!(nextAttemptAt instanceof Date) ||
        Number.isNaN(nextAttemptAt.getTime())) {
      throw new Error('Outbox nextAttemptAt must be a valid date');
    }

    if (props.publishedAt !== undefined &&
        (!(props.publishedAt instanceof Date) ||
         Number.isNaN(props.publishedAt.getTime()))) {
      throw new Error('Outbox publishedAt must be a valid date');
    }

    return new OutboxMessage(
      props.id,
      props.aggregateId,
      props.eventType,
      Object.freeze({ ...props.payload }),
      new Date(props.occurredAt),
      attempts,
      new Date(nextAttemptAt),
      props.publishedAt,
    );
  }

  private assertValidDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error(`${field} must be a valid date`);
    }
  }
}
