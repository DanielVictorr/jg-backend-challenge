
import { createHash } from 'node:crypto';
import { Money } from '../../domain/money/money.js';

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }

  return value;
}

/**
 * Calcula SHA-256 sobre os campos de negócio da transação.
 * A chave de idempotência e metadados HTTP não fazem parte do hash.
 */
export function calculateWagerPayloadHash(
  payload: WagerBusinessPayload,
): string {
  const normalizedMoney = Money.from(payload.money).toJSON();

  const businessPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: normalizedMoney.amount,
      currency: normalizedMoney.currency,
    },
    ...(payload.referenceExternalTransactionId !== undefined
      ? {
          referenceExternalTransactionId:
            payload.referenceExternalTransactionId,
        }
      : {}),
  };

  const canonicalJson = JSON.stringify(canonicalize(businessPayload));

  return createHash('sha256').update(canonicalJson).digest('hex');
}
