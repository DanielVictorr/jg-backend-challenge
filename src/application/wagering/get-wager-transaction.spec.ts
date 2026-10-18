import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
import { GetWagerTransaction } from './get-wager-transaction.js';
describe('GetWagerTransaction', () => {
    const transaction = {
        id: '0192f291-27dd-7d3f-8071-5f8685deef37',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef38',
        playerId: 'player-1',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        status: 'PROCESSED',
        amount: '25.00',
        currency: 'BRL',
        referenceExternalTransactionId: null,
        referenceTransactionId: null,
        failureCode: null,
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        processedAt: new Date('2026-01-01T12:00:01.000Z'),
    } as WagerTransactionEntity;
    function createUseCase(found: WagerTransactionEntity | null) {
        const findOne = vi.fn().mockResolvedValue(found);
        const repository = { findOne };
        const dataSource = {
            getRepository: vi.fn().mockReturnValue(repository),
        } as unknown as DataSource;
        return {
            useCase: new GetWagerTransaction(dataSource),
            findOne,
        };
    }
    it('should find a transaction by internal ID', async () => {
        const { useCase, findOne } = createUseCase(transaction);
        const result = await useCase.executeById(transaction.id);
        expect(findOne).toHaveBeenCalledWith({
            where: { id: transaction.id },
        });
        expect(result.transactionId).toBe(transaction.id);
        expect(result.money).toEqual({
            amount: '25.00',
            currency: 'BRL',
        });
        expect(result.status).toBe('PROCESSED');
        expect('payloadHash' in result).toBe(false);
        expect('idempotencyKey' in result).toBe(false);
    });
    it('should find a transaction by provider and external ID', async () => {
        const { useCase, findOne } = createUseCase(transaction);
        const result = await useCase.executeByExternalId('provider-a', 'transaction-123');
        expect(findOne).toHaveBeenCalledWith({
            where: {
                providerId: 'provider-a',
                externalTransactionId: 'transaction-123',
            },
        });
        expect(result.externalTransactionId).toBe('transaction-123');
    });
    it('should return 404 when the internal ID does not exist', async () => {
        const { useCase } = createUseCase(null);
        await expect(useCase.executeById(transaction.id)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('should return 404 when the external ID does not exist', async () => {
        const { useCase } = createUseCase(null);
        await expect(useCase.executeByExternalId('provider-a', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
});
