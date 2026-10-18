import { Injectable, NotFoundException, } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
export interface GetWagerTransactionOutput {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionEntity['kind'];
    status: WagerTransactionEntity['status'];
    money: {
        amount: string;
        currency: string;
    };
    referenceExternalTransactionId: string | null;
    referenceTransactionId: string | null;
    failureCode: string | null;
    createdAt: Date;
    processedAt: Date | null;
}
@Injectable()
export class GetWagerTransaction {
    constructor(private readonly dataSource: DataSource) { }
    async executeById(transactionId: string): Promise<GetWagerTransactionOutput> {
        const transaction = await this.dataSource
            .getRepository(WagerTransactionEntity)
            .findOne({
            where: { id: transactionId },
        });
        if (!transaction) {
            throw new NotFoundException({
                code: 'WAGER_TRANSACTION_NOT_FOUND',
                message: 'Transação não encontrada.',
            });
        }
        return this.toOutput(transaction);
    }
    async executeByExternalId(providerId: string, externalTransactionId: string): Promise<GetWagerTransactionOutput> {
        const transaction = await this.dataSource
            .getRepository(WagerTransactionEntity)
            .findOne({
            where: {
                providerId,
                externalTransactionId,
            },
        });
        if (!transaction) {
            throw new NotFoundException({
                code: 'WAGER_TRANSACTION_NOT_FOUND',
                message: 'Transação não encontrada.',
            });
        }
        return this.toOutput(transaction);
    }
    private toOutput(transaction: WagerTransactionEntity): GetWagerTransactionOutput {
        return {
            transactionId: transaction.id,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            status: transaction.status,
            money: {
                amount: transaction.amount,
                currency: transaction.currency,
            },
            referenceExternalTransactionId: transaction.referenceExternalTransactionId,
            referenceTransactionId: transaction.referenceTransactionId,
            failureCode: transaction.failureCode,
            createdAt: transaction.createdAt,
            processedAt: transaction.processedAt,
        };
    }
}
