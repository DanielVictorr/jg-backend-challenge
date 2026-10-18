import { describe, expect, it } from 'vitest';
import { InboxMessage } from './inbox-message.js';
const validProps = {
    messageId: 'msg-123',
    consumerName: 'wager-transaction-consumer',
    payloadHash: 'a'.repeat(64),
    receivedAt: new Date('2026-10-17T12:00:00.000Z'),
};
describe('InboxMessage', () => {
    it('recebe uma mensagem ainda não processada', () => {
        const message = InboxMessage.receive(validProps);
        expect(message.messageId).toBe(validProps.messageId);
        expect(message.consumerName).toBe(validProps.consumerName);
        expect(message.payloadHash).toBe(validProps.payloadHash);
        expect(message.isProcessed()).toBe(false);
        expect(message.processedAt).toBeUndefined();
    });
    it('rejeita um hash inválido', () => {
        expect(() => InboxMessage.receive({
            ...validProps,
            payloadHash: 'invalid',
        })).toThrow('Invalid inbox payloadHash');
    });
    it('marca a mensagem como processada', () => {
        const message = InboxMessage.receive(validProps);
        const processedAt = new Date('2026-10-17T12:00:01.000Z');
        message.markProcessed(processedAt);
        expect(message.isProcessed()).toBe(true);
        expect(message.processedAt).toEqual(processedAt);
    });
    it('rehidrata uma mensagem processada', () => {
        const processedAt = new Date('2026-10-17T12:00:01.000Z');
        const message = InboxMessage.rehydrate({
            ...validProps,
            processedAt,
        });
        expect(message.isProcessed()).toBe(true);
        expect(message.processedAt).toEqual(processedAt);
    });
    it('não permite processar a mesma instância duas vezes', () => {
        const message = InboxMessage.receive(validProps);
        message.markProcessed(new Date('2026-10-17T12:00:01.000Z'));
        expect(() => message.markProcessed(new Date('2026-10-17T12:00:02.000Z'))).toThrow('Inbox message is already processed');
    });
    it('não permite uma data de processamento anterior ao recebimento', () => {
        const message = InboxMessage.receive(validProps);
        expect(() => message.markProcessed(new Date('2026-10-17T11:59:59.000Z'))).toThrow('Inbox processedAt cannot precede receivedAt');
    });
});
