import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryPendingReferences } from './retry-pending-references.js';
import { WalletEntity } from '../../database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity.js';
interface Candidate {
    id: string;
    walletId: string;
}
describe('RetryPendingReferences', () => {
    const query = vi.fn();
    const dataSource = {
        query,
    } as unknown as DataSource;
    let subject: RetryPendingReferences;
    const candidates: Candidate[] = [
        {
            id: 'transaction-1',
            walletId: 'wallet-1',
        },
        {
            id: 'transaction-2',
            walletId: 'wallet-2',
        },
    ];
    it('rejeita a transação e registra a Outbox quando as tentativas se esgotam', async () => {
        const pendingTransaction = {
            id: 'transaction-exhausted',
            walletId: 'wallet-1',
            playerId: 'player-1',
            providerId: 'provider-1',
            externalTransactionId: 'external-transaction-1',
            referenceExternalTransactionId: 'missing-reference-1',
            kind: 'REFUND',
            status: 'PENDING_REFERENCE',
            amount: '10.00',
            currency: 'BRL',
            roundId: 'round-1',
            referenceRetryCount: 9,
            referenceNextRetryAt: new Date(Date.now() - 1000),
            referenceExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        const wallet = {
            id: 'wallet-1',
            playerId: 'player-1',
            balance: '100.00',
            currency: 'BRL',
            version: 1,
        };
        const transactionFindOne = vi
            .fn()
            .mockResolvedValueOnce(pendingTransaction)
            .mockResolvedValueOnce(null);
        const transactionUpdate = vi.fn().mockResolvedValue({ affected: 1 });
        const walletFindOneBy = vi.fn().mockResolvedValue(wallet);
        const managerQuery = vi.fn().mockResolvedValue([{ id: 'wallet-1' }]);
        const transactionRepository = {
            findOne: transactionFindOne,
            update: transactionUpdate,
        };
        const walletRepository = {
            findOneBy: walletFindOneBy,
        };
        type Manager = {
            query: typeof managerQuery;
            getRepository: (entity: unknown) => unknown;
        };
        const manager: Manager = {
            query: managerQuery,
            getRepository: vi.fn((entity: unknown) => {
                if (entity === WagerTransactionEntity) {
                    return transactionRepository;
                }
                if (entity === WalletEntity) {
                    return walletRepository;
                }
                throw new Error('Repositório inesperado no teste');
            }),
        };
        const transaction = vi.fn(async (callback: (manager: Manager) => Promise<unknown>) => callback(manager));
        const dataSource = (subject as unknown as {
            dataSource: {
                transaction: typeof transaction;
            };
        }).dataSource;
        dataSource.transaction = transaction;
        await (subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }).processCandidate({
            id: pendingTransaction.id,
            walletId: pendingTransaction.walletId,
        });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transactionUpdate).toHaveBeenCalledWith(pendingTransaction.id, expect.objectContaining({
            status: 'REJECTED',
            failureCode: 'REFERENCE_NOT_FOUND',
            referenceRetryCount: 10,
            referenceNextRetryAt: null,
        }));
        expect(managerQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox_events'), expect.arrayContaining([
            expect.any(String),
            expect.any(String),
            pendingTransaction.walletId,
            'WagerTransactionRejected',
            expect.any(String),
        ]));
        expect(walletFindOneBy).toHaveBeenCalledWith({
            id: pendingTransaction.walletId,
        });
    });
    it('rejeita a transação quando a referência expira antes do limite de tentativas', async () => {
        const pendingTransaction = {
            id: 'transaction-expired',
            referenceRetryCount: 2,
            referenceNextRetryAt: new Date(Date.now() - 1000),
            referenceExpiresAt: new Date(Date.now() - 1000),
            walletId: 'wallet-1',
            playerId: 'player-1',
            providerId: 'provider-1',
            externalTransactionId: 'external-transaction-1',
            referenceExternalTransactionId: 'missing-reference-1',
            kind: 'REFUND',
            status: 'PENDING_REFERENCE',
            amount: '10.00',
            currency: 'BRL',
            roundId: 'round-1',
        };
        const wallet = {
            id: 'wallet-1',
            playerId: 'player-1',
            balance: '100.00',
            currency: 'BRL',
            version: 1,
        };
        const transactionFindOne = vi
            .fn()
            .mockResolvedValueOnce(pendingTransaction)
            .mockResolvedValueOnce(null);
        const transactionUpdate = vi.fn().mockResolvedValue({ affected: 1 });
        const walletFindOneBy = vi.fn().mockResolvedValue(wallet);
        const managerQuery = vi.fn().mockResolvedValue([{ id: 'wallet-1' }]);
        const transactionRepository = {
            findOne: transactionFindOne,
            update: transactionUpdate,
        };
        const walletRepository = {
            findOneBy: walletFindOneBy,
        };
        type Manager = {
            query: typeof managerQuery;
            getRepository: (entity: unknown) => unknown;
        };
        const manager: Manager = {
            query: managerQuery,
            getRepository: vi.fn((entity: unknown) => {
                if (entity === WagerTransactionEntity) {
                    return transactionRepository;
                }
                if (entity === WalletEntity) {
                    return walletRepository;
                }
                throw new Error('Repositório inesperado no teste');
            }),
        };
        const transaction = vi.fn(async (callback: (manager: Manager) => Promise<unknown>) => callback(manager));
        const dataSource = (subject as unknown as {
            dataSource: {
                transaction: typeof transaction;
            };
        }).dataSource;
        dataSource.transaction = transaction;
        await (subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }).processCandidate({
            id: pendingTransaction.id,
            walletId: pendingTransaction.walletId,
        });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transactionUpdate).toHaveBeenCalledWith(pendingTransaction.id, expect.objectContaining({
            status: 'REJECTED',
            failureCode: 'REFERENCE_NOT_FOUND',
            referenceRetryCount: 3,
            referenceNextRetryAt: null,
        }));
        expect(managerQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox_events'), expect.arrayContaining([
            expect.any(String),
            expect.any(String),
            pendingTransaction.walletId,
            'WagerTransactionRejected',
            expect.any(String),
        ]));
        expect(walletFindOneBy).toHaveBeenCalledWith({
            id: pendingTransaction.walletId,
        });
    });
    beforeEach(() => {
        vi.clearAllMocks();
        query.mockResolvedValue([]);
        subject = new RetryPendingReferences(dataSource);
    });
    it('não processa candidatos quando não existem referências pendentes', async () => {
        query.mockResolvedValue([]);
        await subject.processDueReferences();
        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'PENDING_REFERENCE'"), [100]);
    });
    it('consulta referências pendentes e processa todos os candidatos', async () => {
        query.mockResolvedValue(candidates);
        const processCandidate = vi.spyOn(subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }, 'processCandidate');
        processCandidate.mockResolvedValue(undefined);
        await subject.processDueReferences();
        expect(query).toHaveBeenCalledTimes(1);
        expect(processCandidate).toHaveBeenCalledTimes(2);
        expect(processCandidate).toHaveBeenNthCalledWith(1, candidates[0]);
        expect(processCandidate).toHaveBeenNthCalledWith(2, candidates[1]);
    });
    it('continua o lote quando um candidato falha', async () => {
        query.mockResolvedValue(candidates);
        const processCandidate = vi.spyOn(subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }, 'processCandidate');
        processCandidate
            .mockRejectedValueOnce(new Error('Falha simulada'))
            .mockResolvedValueOnce(undefined);
        const errorSpy = vi
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);
        try {
            await subject.processDueReferences();
            expect(processCandidate).toHaveBeenCalledTimes(2);
            expect(errorSpy).toHaveBeenCalledTimes(1);
        }
        finally {
            errorSpy.mockRestore();
        }
    });
    it('não inicia outra execução enquanto o processamento atual está ativo', async () => {
        query.mockResolvedValue(candidates);
        let finishProcessing: (() => void) | undefined;
        const processing = new Promise<void>((resolve) => {
            finishProcessing = resolve;
        });
        const processCandidate = vi.spyOn(subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }, 'processCandidate');
        processCandidate.mockReturnValue(processing);
        const firstRun = subject.processDueReferences();
        await vi.waitFor(() => {
            expect(processCandidate).toHaveBeenCalledTimes(1);
        });
        await subject.processDueReferences();
        expect(query).toHaveBeenCalledTimes(1);
        finishProcessing?.();
        await firstRun;
        expect(processCandidate).toHaveBeenCalledTimes(2);
    });
    it('mantém a referência pendente e agenda nova tentativa quando a referência não é encontrada', async () => {
        const pendingTransaction = {
            id: 'transaction-1',
            walletId: 'wallet-1',
            status: 'PENDING_REFERENCE',
            providerId: 'provider-1',
            externalTransactionId: 'external-reference-1',
            referenceRetryCount: 0,
            referenceNextRetryAt: null,
            referenceExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        const managerQuery = vi.fn().mockResolvedValue([{ id: 'wallet-1' }]);
        const findOne = vi
            .fn()
            .mockResolvedValueOnce(pendingTransaction)
            .mockResolvedValueOnce(null);
        const update = vi.fn().mockResolvedValue({ affected: 1 });
        const transactionRepository = { findOne, update };
        const manager = {
            query: managerQuery,
            getRepository: vi.fn().mockReturnValue(transactionRepository),
        };
        const transaction = vi.fn(async (callback: (transactionManager: typeof manager) => Promise<unknown>) => callback(manager));
        const mockedDataSource = subject as unknown as {
            dataSource: {
                transaction: typeof transaction;
            };
        };
        mockedDataSource.dataSource.transaction = transaction;
        await (subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }).processCandidate({
            id: pendingTransaction.id,
            walletId: pendingTransaction.walletId,
        });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(pendingTransaction.id, expect.objectContaining({
            referenceRetryCount: 1,
            referenceNextRetryAt: expect.any(Date),
        }));
        const updatedValues = update.mock.calls[0]?.[1] as {
            referenceRetryCount: number;
            referenceNextRetryAt: Date;
        };
        expect(updatedValues.referenceNextRetryAt.getTime()).toBeGreaterThan(Date.now());
    });
    it('aplica o limite máximo de 900 segundos ao agendar nova tentativa', async () => {
        const pendingTransaction = {
            id: 'transaction-1',
            walletId: 'wallet-1',
            status: 'PENDING_REFERENCE',
            providerId: 'provider-1',
            externalTransactionId: 'external-reference-1',
            referenceRetryCount: 8,
            referenceNextRetryAt: new Date(Date.now() - 1000),
            referenceExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        };
        const managerQuery = vi.fn().mockResolvedValue([{ id: 'wallet-1' }]);
        const findOne = vi
            .fn()
            .mockResolvedValueOnce(pendingTransaction)
            .mockResolvedValueOnce(null);
        const update = vi.fn().mockResolvedValue({ affected: 1 });
        const transactionRepository = { findOne, update };
        const manager = {
            query: managerQuery,
            getRepository: vi.fn().mockReturnValue(transactionRepository),
        };
        const transaction = vi.fn(async (callback: (transactionManager: typeof manager) => Promise<unknown>) => callback(manager));
        const mockedDataSource = subject as unknown as {
            dataSource: {
                transaction: typeof transaction;
            };
        };
        const before = Date.now();
        mockedDataSource.dataSource.transaction = transaction;
        await (subject as unknown as {
            processCandidate: (candidate: Candidate) => Promise<void>;
        }).processCandidate({
            id: pendingTransaction.id,
            walletId: pendingTransaction.walletId,
        });
        const updateCall = update.mock.calls[0];
        expect(updateCall).toBeDefined();
        const updateValues = updateCall![1];
        expect(updateValues.referenceRetryCount).toBe(9);
        const nextRetryAt = updateValues.referenceNextRetryAt as Date;
        expect(nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + 900000 - 1000);
        expect(nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 900000 + 1000);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(pendingTransaction.id, expect.objectContaining({
            referenceRetryCount: 9,
        }));
        expect(nextRetryAt).toBeInstanceOf(Date);
        expect(nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + 900000 - 1000);
        expect(nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 900000 + 1000);
        const updatedValues = update.mock.calls[0]?.[1] as {
            referenceRetryCount: number;
            referenceNextRetryAt: Date;
        };
        expect(updatedValues.referenceNextRetryAt.getTime()).toBeGreaterThan(Date.now());
    });
});
