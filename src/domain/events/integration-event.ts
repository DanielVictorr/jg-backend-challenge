export interface IntegrationEventProps<T> {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: T;
}
export interface SerializedIntegrationEvent<T> {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
}
export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;
    public readonly eventId: string;
    public readonly aggregateId: string;
    public readonly correlationId: string;
    public readonly causationId?: string;
    public readonly occurredAt: Date;
    public readonly data: Readonly<T>;
    protected constructor(props: IntegrationEventProps<T>) {
        if (!props.eventId.trim()) {
            throw new Error('Event id is required');
        }
        if (!props.aggregateId.trim()) {
            throw new Error('Aggregate id is required');
        }
        if (!props.correlationId.trim()) {
            throw new Error('Correlation id is required');
        }
        if (!(props.occurredAt instanceof Date) ||
            Number.isNaN(props.occurredAt.getTime())) {
            throw new Error('Event occurredAt must be a valid date');
        }
        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = new Date(props.occurredAt.getTime());
        this.data = Object.freeze({ ...props.data });
    }
    toJSON(): SerializedIntegrationEvent<T> {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            aggregateId: this.aggregateId,
            correlationId: this.correlationId,
            ...(this.causationId !== undefined
                ? { causationId: this.causationId }
                : {}),
            occurredAt: this.occurredAt.toISOString(),
            version: this.version,
            data: this.data as T,
        };
    }
}
