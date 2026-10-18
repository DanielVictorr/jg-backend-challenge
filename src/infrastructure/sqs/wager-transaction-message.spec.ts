import { describe, expect, it } from 'vitest';
import { parseWagerTransactionMessage, } from './wager-transaction-message.js';
const validMessage = {
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-17T15:00:00.000Z',
    data: {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        idempotencyKey: 'provider-a:transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: {
            amount: '25.00',
            currency: 'BRL',
        },
    },
};
describe('parseWagerTransactionMessage', () => {
    it('valida a mensagem de entrada e calcula o hash', () => {
        const result = parseWagerTransactionMessage(JSON.stringify(validMessage));
        expect(result.messageId).toBe('msg-123');
        expect(result.input.idempotencyKey).toBe('provider-a:transaction-123');
        expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });
    it('rejeita JSON inválido', () => {
        expect(() => parseWagerTransactionMessage('{')).toThrow();
    });
    it('rejeita tipos de mensagem não suportados', () => {
        expect(() => parseWagerTransactionMessage(JSON.stringify({
            ...validMessage,
            type: 'WalletBalanceChanged',
        }))).toThrow();
    });
    it('rejeita mensagem sem messageId', () => {
        const { messageId: _messageId, ...message } = validMessage;
        expect(() => parseWagerTransactionMessage(JSON.stringify(message))).toThrow();
    });
    it('rejeita dados sem money', () => {
        const { money: _money, ...data } = validMessage.data;
        expect(() => parseWagerTransactionMessage(JSON.stringify({
            ...validMessage,
            data,
        }))).toThrow();
    });
    it('calcula o mesmo hash para os mesmos dados de negócio', () => {
        const first = parseWagerTransactionMessage(JSON.stringify(validMessage));
        const second = parseWagerTransactionMessage(JSON.stringify({
            ...validMessage,
            occurredAt: '2026-10-17T16:00:00.000Z',
        }));
        expect(second.payloadHash).toBe(first.payloadHash);
    });
});
