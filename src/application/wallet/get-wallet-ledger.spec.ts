import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetWalletLedger } from './get-wallet-ledger.js';
describe('GetWalletLedger', () => {
    const walletId = '11111111-1111-4111-8111-111111111111';
    const entryId = '22222222-2222-4222-8222-222222222222';
    const transactionId = '33333333-3333-4333-8333-333333333333';
    const createdAt = '2026-10-17T10:30:00.123456Z';
    const walletRepository = {
        findOne: vi.fn(),
    };
    const dataSource = {
        getRepository: vi.fn(() => walletRepository),
        query: vi.fn(),
    };
    let service: GetWalletLedger;
    const makeEntry = (id = entryId) => ({
        id,
        walletId,
        transactionId,
        entryType: 'CREDIT' as const,
        amount: '1250.75',
        currency: 'BRL',
        balanceBefore: '0.00',
        balanceAfter: '1250.75',
        createdAt,
    });
    beforeEach(() => {
        vi.clearAllMocks();
        walletRepository.findOne.mockResolvedValue({ id: walletId });
        dataSource.query.mockResolvedValue([]);
        service = new GetWalletLedger(dataSource as unknown as DataSource);
    });
    it('deve retornar o extrato vazio quando não houver lançamentos', async () => {
        const result = await service.execute(walletId);
        expect(result).toEqual({
            items: [],
            nextCursor: null,
            hasMore: false,
        });
        expect(dataSource.query).toHaveBeenCalledOnce();
    });
    it('deve preservar os valores monetários como strings', async () => {
        dataSource.query.mockResolvedValue([makeEntry()]);
        const result = await service.execute(walletId);
        expect(result.items[0]).toEqual(makeEntry());
        expect(typeof result.items[0].amount).toBe('string');
        expect(typeof result.items[0].balanceBefore).toBe('string');
        expect(typeof result.items[0].balanceAfter).toBe('string');
        expect(result.nextCursor).toBeNull();
        expect(result.hasMore).toBe(false);
    });
    it('deve usar o limite padrão de 50 e buscar um registro extra', async () => {
        await service.execute(walletId);
        expect(dataSource.query).toHaveBeenCalledOnce();
        const [, parameters] = dataSource.query.mock.calls[0] as [
            string,
            unknown[]
        ];
        expect(parameters).toEqual([walletId, 51]);
    });
    it('deve gerar um cursor quando houver outra página', async () => {
        const entries = Array.from({ length: 3 }, (_, index) => makeEntry(`22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`));
        dataSource.query.mockResolvedValue(entries);
        const result = await service.execute(walletId, undefined, 2);
        expect(result.items).toHaveLength(2);
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).not.toBeNull();
        const decodedCursor = JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8')) as {
            createdAt: string;
            id: string;
        };
        expect(decodedCursor).toEqual({
            createdAt,
            id: entries[1].id,
        });
    });
    it('deve rejeitar um limite fora do intervalo permitido', async () => {
        await expect(service.execute(walletId, undefined, 0)).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.execute(walletId, undefined, 101)).rejects.toBeInstanceOf(BadRequestException);
        expect(walletRepository.findOne).not.toHaveBeenCalled();
        expect(dataSource.query).not.toHaveBeenCalled();
    });
    it('deve rejeitar um cursor inválido', async () => {
        await expect(service.execute(walletId, 'cursor-invalido')).rejects.toBeInstanceOf(BadRequestException);
        expect(dataSource.query).not.toHaveBeenCalled();
    });
    it('deve retornar 404 quando a carteira não existir', async () => {
        walletRepository.findOne.mockResolvedValue(null);
        await expect(service.execute(walletId)).rejects.toBeInstanceOf(NotFoundException);
        expect(dataSource.query).not.toHaveBeenCalled();
    });
    it('deve aplicar o cursor e ordenar por timestamp e ID', async () => {
        const cursor = Buffer.from(JSON.stringify({ createdAt, id: entryId })).toString('base64url');
        await service.execute(walletId, cursor, 10);
        const [sql, parameters] = dataSource.query.mock.calls[0] as [
            string,
            unknown[]
        ];
        expect(sql).toContain('(le.created_at, le.id) < ($2::timestamptz, $3::uuid)');
        expect(sql).toContain('ORDER BY le.created_at DESC, le.id DESC');
        expect(parameters).toEqual([walletId, createdAt, entryId, 11]);
    });
});
