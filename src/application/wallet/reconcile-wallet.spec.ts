import { Logger, NotFoundException } from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import type { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconcileWallet } from './reconcile-wallet.js';
describe('ReconcileWallet', () => {
    const walletId = '7b3d0e9a-9a1f-4a6a-8c1a-123456789abc';
    const query = vi.fn();
    const dataSource = {
        query,
    } as unknown as DataSource;
    const increment = vi.fn();
    const counter = vi.fn().mockReturnValue({ increment });
    const tracerService = {
        counter,
    } as unknown as TracerService;
    let subject: ReconcileWallet;
    const consistentRow = {
        walletId,
        currency: 'BRL',
        storedBalance: '100.00',
        calculatedBalance: '100.00',
        difference: '0.00',
        checkedEntries: 2,
        consistent: true,
    };
    const inconsistentRow = {
        walletId,
        currency: 'BRL',
        storedBalance: '120.00',
        calculatedBalance: '100.00',
        difference: '20.00',
        checkedEntries: 2,
        consistent: false,
    };
    beforeEach(() => {
        vi.clearAllMocks();
        counter.mockReturnValue({ increment });
        subject = new ReconcileWallet(dataSource, tracerService);
    });
    it('retorna os saldos como strings quando a carteira está consistente', async () => {
        query.mockResolvedValue([consistentRow]);
        const result = await subject.execute(walletId);
        expect(result).toEqual({
            walletId,
            storedBalance: {
                amount: '100.00',
                currency: 'BRL',
            },
            calculatedBalance: {
                amount: '100.00',
                currency: 'BRL',
            },
            difference: {
                amount: '0.00',
                currency: 'BRL',
            },
            consistent: true,
            checkedEntries: 2,
        });
        expect(typeof result.storedBalance.amount).toBe('string');
        expect(typeof result.calculatedBalance.amount).toBe('string');
        expect(typeof result.difference.amount).toBe('string');
        expect(counter).not.toHaveBeenCalled();
    });
    it('contabiliza a divergência e retorna a diferença sem corrigir o saldo', async () => {
        query.mockResolvedValue([inconsistentRow]);
        const result = await subject.execute(walletId);
        expect(result.consistent).toBe(false);
        expect(result.storedBalance.amount).toBe('120.00');
        expect(result.calculatedBalance.amount).toBe('100.00');
        expect(result.difference.amount).toBe('20.00');
        expect(counter).toHaveBeenCalledWith('wallet_reconciliation_discrepancies_total', expect.objectContaining({
            description: expect.any(String),
        }));
        expect(increment).toHaveBeenCalledTimes(1);
        expect(increment).toHaveBeenCalledWith();
        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith(expect.any(String), [walletId]);
    });
    it('lança WALLET_NOT_FOUND quando a carteira não existe', async () => {
        query.mockResolvedValue([]);
        await expect(subject.execute(walletId)).rejects.toThrow(NotFoundException);
        await expect(subject.execute(walletId)).rejects.toMatchObject({
            response: {
                code: 'WALLET_NOT_FOUND',
            },
            status: 404,
        });
        expect(counter).not.toHaveBeenCalled();
    });
    it('funciona sem TracerService configurado', async () => {
        query.mockResolvedValue([inconsistentRow]);
        const subjectWithoutMetrics = new ReconcileWallet(dataSource);
        const result = await subjectWithoutMetrics.execute(walletId);
        expect(result.consistent).toBe(false);
        expect(result.difference.amount).toBe('20.00');
    });
    it('não falha a reconciliação quando a métrica gera um erro', async () => {
        query.mockResolvedValue([inconsistentRow]);
        counter.mockImplementation(() => {
            throw new Error('Falha simulada na instrumentação');
        });
        const result = await subject.execute(walletId);
        expect(result.consistent).toBe(false);
        expect(result.difference.amount).toBe('20.00');
    });
    it('não registra os valores financeiros completos no log de divergência', async () => {
        query.mockResolvedValue([inconsistentRow]);
        const warnSpy = vi
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        try {
            await subject.execute(walletId);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const loggedValue = String(warnSpy.mock.calls[0][0]);
            expect(loggedValue).toContain('wallet_reconciliation_discrepancy');
            expect(loggedValue).toContain(walletId);
            expect(loggedValue).not.toContain('120.00');
            expect(loggedValue).not.toContain('100.00');
            expect(loggedValue).not.toContain('20.00');
        }
        finally {
            warnSpy.mockRestore();
        }
    });
});
