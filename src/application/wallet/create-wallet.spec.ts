import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { CreateWallet } from './create-wallet.js';
import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
describe('CreateWallet', () => {
    const walletRepository = {
        create: vi.fn((value: unknown) => value),
        save: vi.fn(async (value: unknown) => value),
    };
    const transactionRepository = {
        create: vi.fn((value: unknown) => value),
        save: vi.fn(async (value: unknown) => value),
    };
    const ledgerRepository = {
        create: vi.fn((value: unknown) => value),
        save: vi.fn(async (value: unknown) => value),
    };
    const query = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
    const managerMock = {
        getRepository: vi.fn((entity: unknown) => {
            if (entity === WalletEntity)
                return walletRepository;
            if (entity === WagerTransactionEntity)
                return transactionRepository;
            if (entity === LedgerEntryEntity)
                return ledgerRepository;
            throw new Error('Unexpected repository');
        }),
        query,
    };
    const manager = managerMock as unknown as EntityManager;
    const transaction = vi.fn(async (callback: (manager: EntityManager) => Promise<unknown>) => callback(manager));
    const dataSource = {
        transaction,
    } as unknown as DataSource;
    const useCase = new CreateWallet(dataSource);
    const validInput = {
        playerId: 'player-001',
        initialBalance: {
            amount: '1000.00',
            currency: 'BRL',
        },
    };
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('creates a wallet and records the opening transaction, ledger and outbox events', async () => {
        const result = await useCase.execute(validInput);
        expect(result).toMatchObject({
            playerId: 'player-001',
            balance: {
                amount: '1000.00',
                currency: 'BRL',
            },
            version: 1,
        });
        expect(result.id).toBeTruthy();
        expect(transaction).toHaveBeenCalledOnce();
        expect(walletRepository.save).toHaveBeenCalledOnce();
        expect(transactionRepository.save).toHaveBeenCalledOnce();
        expect(ledgerRepository.save).toHaveBeenCalledOnce();
        expect(transactionRepository.save.mock.calls[0][0]).toMatchObject({
            kind: 'OPENING',
            status: 'PROCESSED',
            amount: '1000.00',
            currency: 'BRL',
            walletId: result.id,
        });
        expect(ledgerRepository.save.mock.calls[0][0]).toMatchObject({
            walletId: result.id,
            entryType: 'CREDIT',
            amount: '1000.00',
            balanceBefore: '0.00',
            balanceAfter: '1000.00',
        });
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.map((call) => {
            const params = call[1] as unknown[] | undefined;
            return params?.[3];
        })).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
    });
    it('creates a zero-balance wallet without an opening transaction or ledger entry', async () => {
        const result = await useCase.execute({
            ...validInput,
            initialBalance: {
                amount: '0.00',
                currency: 'BRL',
            },
        });
        expect(result.balance.amount).toBe('0.00');
        expect(result.version).toBe(1);
        expect(walletRepository.save).toHaveBeenCalledOnce();
        expect(transactionRepository.save).not.toHaveBeenCalled();
        expect(ledgerRepository.save).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });
    it('rejects an empty player ID before starting a database transaction', async () => {
        await expect(useCase.execute({
            ...validInput,
            playerId: ' ',
        })).rejects.toBeInstanceOf(BadRequestException);
        expect(transaction).not.toHaveBeenCalled();
    });
    it('rejects an amount with more than two decimal places', async () => {
        await expect(useCase.execute({
            ...validInput,
            initialBalance: {
                amount: '10.123',
                currency: 'BRL',
            },
        })).rejects.toBeInstanceOf(BadRequestException);
        expect(transaction).not.toHaveBeenCalled();
    });
    it('rejects an invalid currency', async () => {
        await expect(useCase.execute({
            ...validInput,
            initialBalance: {
                amount: '10.00',
                currency: 'brl',
            },
        })).rejects.toBeInstanceOf(BadRequestException);
        expect(transaction).not.toHaveBeenCalled();
    });
    it('rejects an amount exceeding the supported database precision', async () => {
        await expect(useCase.execute({
            ...validInput,
            initialBalance: {
                amount: '1000000000000000000.00',
                currency: 'BRL',
            },
        })).rejects.toBeInstanceOf(BadRequestException);
        expect(transaction).not.toHaveBeenCalled();
    });
    it('maps the wallet unique constraint to a conflict exception', async () => {
        const driverError = Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'uq_wallets_player_currency',
        });
        const databaseError = new QueryFailedError('INSERT INTO wallets', [], driverError);
        transaction.mockRejectedValueOnce(databaseError);
        await expect(useCase.execute(validInput)).rejects.toBeInstanceOf(ConflictException);
        expect(transaction).toHaveBeenCalledOnce();
    });
    it('does not map other unique constraints to a wallet conflict', async () => {
        const driverError = Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'uq_wagering_provider_idempotency',
        });
        const databaseError = new QueryFailedError('INSERT INTO wagering_transactions', [], driverError);
        transaction.mockRejectedValueOnce(databaseError);
        await expect(useCase.execute(validInput)).rejects.toBe(databaseError);
        expect(transaction).toHaveBeenCalledOnce();
    });
});
