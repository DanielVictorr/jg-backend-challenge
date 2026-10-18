import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WalletEntity } from '../../database/entities/wallet.entity.js';
export interface GetWalletOutput {
    id: string;
    playerId: string;
    balance: {
        amount: string;
        currency: string;
    };
    version: number;
    createdAt: Date;
    updatedAt: Date;
}
@Injectable()
export class GetWallet {
    constructor(private readonly dataSource: DataSource) { }
    async execute(walletId: string): Promise<GetWalletOutput> {
        const wallet = await this.dataSource
            .getRepository(WalletEntity)
            .findOne({
            where: { id: walletId },
        });
        if (!wallet) {
            throw new NotFoundException({
                code: 'WALLET_NOT_FOUND',
                message: 'Carteira não encontrada.',
            });
        }
        return {
            id: wallet.id,
            playerId: wallet.playerId,
            balance: {
                amount: wallet.balance,
                currency: wallet.currency,
            },
            version: wallet.version,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
        };
    }
}
