import { describe, expect, it } from 'vitest';
import { IntegrationEvent, type IntegrationEventProps, } from './integration-event.js';
interface TestEventData {
    walletId: string;
    amount: string;
}
class TestIntegrationEvent extends IntegrationEvent<TestEventData> {
    readonly eventType = 'TestIntegrationEvent';
    readonly version = 1;
    constructor(props: IntegrationEventProps<TestEventData>) {
        super(props);
        Object.freeze(this);
    }
}
describe('IntegrationEvent', () => {
    const props: IntegrationEventProps<TestEventData> = {
        eventId: 'event-1',
        aggregateId: 'wallet-1',
        correlationId: 'correlation-1',
        occurredAt: new Date('2026-01-01T12:00:00.000Z'),
        data: {
            walletId: 'wallet-1',
            amount: '100.00',
        },
    };
    it('serializes the standard event envelope', () => {
        const event = new TestIntegrationEvent(props);
        expect(event.toJSON()).toEqual({
            eventId: 'event-1',
            eventType: 'TestIntegrationEvent',
            aggregateId: 'wallet-1',
            correlationId: 'correlation-1',
            occurredAt: '2026-01-01T12:00:00.000Z',
            version: 1,
            data: {
                walletId: 'wallet-1',
                amount: '100.00',
            },
        });
    });
    it('includes causationId when provided', () => {
        const event = new TestIntegrationEvent({
            ...props,
            causationId: 'command-1',
        });
        expect(event.toJSON().causationId).toBe('command-1');
    });
    it('rejects an empty event id', () => {
        expect(() => new TestIntegrationEvent({
            ...props,
            eventId: ' ',
        })).toThrow('Event id is required');
    });
    it('rejects an invalid occurrence date', () => {
        expect(() => new TestIntegrationEvent({
            ...props,
            occurredAt: new Date('invalid'),
        })).toThrow('Event occurredAt must be a valid date');
    });
});
