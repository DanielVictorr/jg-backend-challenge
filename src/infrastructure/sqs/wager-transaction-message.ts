import { BadRequestException } from '@nestjs/common';
import type { ProcessWagerTransactionInput } from '../../application/wagering/process-wager-transaction.js';
import { calculateWagerPayloadHash } from '../../application/wagering/canonical-payload.js';
export interface WagerTransactionRequestedMessage {
    messageId: string;
    type: 'WagerTransactionRequested';
    occurredAt: string;
    data: ProcessWagerTransactionInput;
}
export interface ParsedWagerTransactionMessage {
    messageId: string;
    input: ProcessWagerTransactionInput;
    payloadHash: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value));
}
export function parseWagerTransactionMessage(body: string): ParsedWagerTransactionMessage {
    let envelope: unknown;
    try {
        envelope = JSON.parse(body) as unknown;
    }
    catch {
        throw new BadRequestException({
            code: 'INVALID_SQS_JSON',
            message: 'O corpo da mensagem SQS não contém JSON válido.',
        });
    }
    if (!isRecord(envelope)) {
        throw new BadRequestException({
            code: 'INVALID_SQS_ENVELOPE',
            message: 'O envelope da mensagem SQS deve ser um objeto.',
        });
    }
    if (typeof envelope.messageId !== 'string' ||
        !envelope.messageId.trim() ||
        envelope.messageId.length > 255) {
        throw new BadRequestException({
            code: 'INVALID_SQS_MESSAGE_ID',
            message: 'O messageId da mensagem SQS é inválido.',
        });
    }
    if (envelope.type !== 'WagerTransactionRequested') {
        throw new BadRequestException({
            code: 'UNSUPPORTED_SQS_MESSAGE_TYPE',
            message: 'O tipo da mensagem SQS não é suportado.',
        });
    }
    if (typeof envelope.occurredAt !== 'string' ||
        Number.isNaN(Date.parse(envelope.occurredAt))) {
        throw new BadRequestException({
            code: 'INVALID_SQS_OCCURRED_AT',
            message: 'O occurredAt da mensagem SQS é inválido.',
        });
    }
    if (!isRecord(envelope.data)) {
        throw new BadRequestException({
            code: 'INVALID_SQS_DATA',
            message: 'O campo data da mensagem SQS deve ser um objeto.',
        });
    }
    const data = envelope.data;
    const requiredStrings = [
        'providerId',
        'externalTransactionId',
        'idempotencyKey',
        'playerId',
        'walletId',
        'roundId',
        'gameId',
        'kind',
    ] as const;
    for (const field of requiredStrings) {
        if (typeof data[field] !== 'string' ||
            !data[field].trim()) {
            throw new BadRequestException({
                code: 'INVALID_SQS_DATA',
                message: `O campo ${field} da mensagem SQS é obrigatório.`,
            });
        }
    }
    if (!isRecord(data.money)) {
        throw new BadRequestException({
            code: 'INVALID_SQS_MONEY',
            message: 'O campo money da mensagem SQS é inválido.',
        });
    }
    if (typeof data.money.amount !== 'string' ||
        typeof data.money.currency !== 'string') {
        throw new BadRequestException({
            code: 'INVALID_SQS_MONEY',
            message: 'O valor e a moeda da mensagem SQS devem ser strings.',
        });
    }
    if (data.referenceExternalTransactionId !== undefined &&
        typeof data.referenceExternalTransactionId !== 'string') {
        throw new BadRequestException({
            code: 'INVALID_SQS_REFERENCE',
            message: 'A referência externa da mensagem SQS é inválida.',
        });
    }
    const input: ProcessWagerTransactionInput = {
        providerId: data.providerId as string,
        externalTransactionId: data.externalTransactionId as string,
        idempotencyKey: data.idempotencyKey as string,
        playerId: data.playerId as string,
        walletId: data.walletId as string,
        roundId: data.roundId as string,
        gameId: data.gameId as string,
        kind: data.kind as string,
        money: {
            amount: data.money.amount,
            currency: data.money.currency,
        },
        ...(data.referenceExternalTransactionId !== undefined
            ? {
                referenceExternalTransactionId: data.referenceExternalTransactionId as string,
            }
            : {}),
    };
    const payloadHash = calculateWagerPayloadHash(input);
    return {
        messageId: envelope.messageId,
        input,
        payloadHash,
    };
}
