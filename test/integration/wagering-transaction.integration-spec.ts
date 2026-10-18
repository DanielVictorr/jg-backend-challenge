import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
describe('Wagering transactions â€” integraÃ§Ã£o HTTP', () => {
    let app: INestApplication;
    let createWallet: CreateWallet;
    let processWager: ProcessWagerTransaction;
    beforeAll(async () => {
        if (process.env.DB_DATABASE !== 'jg_backend_integration' ||
            process.env.DB_PORT !== '55432') {
            throw new Error('Teste bloqueado: configure o banco jg_backend_integration na porta 55432.');
        }
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        createWallet = app.get(CreateWallet);
        processWager = app.get(ProcessWagerTransaction);
    });
    afterAll(async () => {
        if (app) {
            await app.close();
        }
    });
    async function createProcessedWin() {
        const uniqueId = randomUUID();
        const playerId = `wager-query-player-${uniqueId}`;
        const providerId = `wager-query-provider-${uniqueId}`;
        const externalTransactionId = `wager-query-external-${uniqueId}`;
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: {
                amount: '100.00',
                currency: 'BRL',
            },
        });
        const transaction = await processWager.execute({
            providerId,
            externalTransactionId,
            idempotencyKey: `wager-query-idempotency-${uniqueId}`,
            playerId,
            walletId: wallet.id,
            roundId: `wager-query-round-${uniqueId}`,
            gameId: 'integration-query-test',
            kind: 'WIN',
            money: {
                amount: '25.50',
                currency: 'BRL',
            },
        });
        return {
            transaction,
            providerId,
            externalTransactionId,
        };
    }
    it('deve consultar uma transaÃ§Ã£o pelo ID interno', async () => {
        const { transaction, providerId, externalTransactionId } = await createProcessedWin();
        const response = await request(app.getHttpServer())
            .get(`/wagering/transactions/${transaction.transactionId}`)
            .expect(200);
        expect(response.body.transactionId).toBe(transaction.transactionId);
        expect(response.body.walletId).toBe(transaction.walletId);
        expect(response.body.providerId).toBe(providerId);
        expect(response.body.externalTransactionId).toBe(externalTransactionId);
        expect(response.body.status).toBe('PROCESSED');
        expect(response.body.money).toEqual({
            amount: '25.50',
            currency: 'BRL',
        });
        expect(typeof response.body.money.amount).toBe('string');
        expect(response.body).not.toHaveProperty('idempotencyKey');
        expect(response.body).not.toHaveProperty('payloadHash');
    });
    it('deve consultar uma transaÃ§Ã£o pelo provedor e ID externo', async () => {
        const { transaction, providerId, externalTransactionId } = await createProcessedWin();
        const response = await request(app.getHttpServer())
            .get(`/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`)
            .expect(200);
        expect(response.body.transactionId).toBe(transaction.transactionId);
        expect(response.body.providerId).toBe(providerId);
        expect(response.body.externalTransactionId).toBe(externalTransactionId);
        expect(response.body.money).toEqual({
            amount: '25.50',
            currency: 'BRL',
        });
        expect(typeof response.body.money.amount).toBe('string');
    });
    it('deve retornar 404 para um ID interno inexistente', async () => {
        const response = await request(app.getHttpServer())
            .get(`/wagering/transactions/${randomUUID()}`)
            .expect(404);
        expect(response.body.code).toBe('WAGER_TRANSACTION_NOT_FOUND');
    });
    it('deve retornar 400 para um ID interno que nÃ£o seja UUID', async () => {
        await request(app.getHttpServer())
            .get('/wagering/transactions/uuid-invalido')
            .expect(400);
    });
    it('deve retornar 404 para um ID externo inexistente', async () => {
        const uniqueId = randomUUID();
        const response = await request(app.getHttpServer())
            .get(`/providers/provider-${uniqueId}/wagering/transactions/external-${uniqueId}`)
            .expect(404);
        expect(response.body.code).toBe('WAGER_TRANSACTION_NOT_FOUND');
    });
});
