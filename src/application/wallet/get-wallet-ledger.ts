import { BadRequestException, Injectable, NotFoundException, } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WalletEntity } from '../../database/entities/wallet.entity.js';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
interface LedgerCursor {
    createdAt: string;
    id: string;
}
interface LedgerRow {
    id: string;
    walletId: string;
    transactionId: string;
    entryType: 'CREDIT' | 'DEBIT';
    amount: string;
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt: string;
}
export interface GetWalletLedgerOutput {
    items: LedgerRow[];
    nextCursor: string | null;
    hasMore: boolean;
}
@Injectable()
export class GetWalletLedger {
    constructor(private readonly dataSource: DataSource) { }
    async execute(walletId: string, cursor?: string, requestedLimit?: number): Promise<GetWalletLedgerOutput> {
        const limit = requestedLimit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) ||
            limit < 1 ||
            limit > MAX_LIMIT) {
            throw new BadRequestException({
                code: 'INVALID_LEDGER_LIMIT',
                message: `O limite deve ser um inteiro entre 1 e ${MAX_LIMIT}.`,
            });
        }
        const decodedCursor = cursor
            ? this.decodeCursor(cursor)
            : undefined;
        const wallet = await this.dataSource
            .getRepository(WalletEntity)
            .findOne({
            where: { id: walletId },
            select: { id: true },
        });
        if (!wallet) {
            throw new NotFoundException({
                code: 'WALLET_NOT_FOUND',
                message: 'Carteira não encontrada.',
            });
        }
        const parameters: unknown[] = [walletId];
        let cursorCondition = '';
        if (decodedCursor) {
            parameters.push(decodedCursor.createdAt, decodedCursor.id);
            cursorCondition =
                'AND (le.created_at, le.id) < ($2::timestamptz, $3::uuid)';
        }
        parameters.push(limit + 1);
        const limitParameter = `$${parameters.length}`;
        const rows: LedgerRow[] = await this.dataSource.query(`
        SELECT
          le.id AS "id",
          le.wallet_id AS "walletId",
          le.transaction_id AS "transactionId",
          le.entry_type AS "entryType",
          le.amount::text AS "amount",
          le.currency AS "currency",
          le.balance_before::text AS "balanceBefore",
          le.balance_after::text AS "balanceAfter",
          to_char(
            le.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS "createdAt"
        FROM ledger_entries le
        WHERE le.wallet_id = $1::uuid
          ${cursorCondition}
        ORDER BY le.created_at DESC, le.id DESC
        LIMIT ${limitParameter}
      `, parameters);
        const hasMore = rows.length > limit;
        const items = rows.slice(0, limit);
        const lastItem = items.at(-1);
        return {
            items,
            hasMore,
            nextCursor: hasMore && lastItem
                ? this.encodeCursor({
                    createdAt: lastItem.createdAt,
                    id: lastItem.id,
                })
                : null,
        };
    }
    private encodeCursor(cursor: LedgerCursor): string {
        return Buffer.from(JSON.stringify(cursor)).toString('base64url');
    }
    private decodeCursor(cursor: string): LedgerCursor {
        try {
            const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
            if (typeof decoded !== 'object' ||
                decoded === null ||
                !('createdAt' in decoded) ||
                !('id' in decoded) ||
                typeof decoded.createdAt !== 'string' ||
                typeof decoded.id !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.createdAt) ||
                Number.isNaN(Date.parse(decoded.createdAt)) ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)) {
                throw new Error('Invalid cursor');
            }
            return {
                createdAt: decoded.createdAt,
                id: decoded.id,
            };
        }
        catch {
            throw new BadRequestException({
                code: 'INVALID_LEDGER_CURSOR',
                message: 'O cursor do extrato é inválido.',
            });
        }
    }
}
