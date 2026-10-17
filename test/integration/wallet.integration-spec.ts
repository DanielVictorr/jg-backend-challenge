import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';

describe('Wallet â€” integraÃ§Ã£o HTTP', () => {
  let app: INestApplication;
  let createWallet: CreateWallet;
  let processWager: ProcessWagerTransaction;

  beforeAll(async () => {
    if (
      process.env.DB_DATABASE !== 'jg_backend_integration' ||
      process.env.DB_PORT !== '55432'
    ) {
      throw new Error(
        'Teste bloqueado: configure o banco jg_backend_integration na porta 55432.',
      );
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

  it('deve retornar os dados de uma carteira existente', async () => {
    const uniqueId = randomUUID();

    const wallet = await createWallet.execute({
      playerId: `wallet-integration-${uniqueId}`,
      initialBalance: {
        amount: '1250.75',
        currency: 'BRL',
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200);

    expect(response.body.id).toBe(wallet.id);
    expect(response.body.playerId).toBe(
      `wallet-integration-${uniqueId}`,
    );
    expect(response.body.balance).toEqual({
      amount: '1250.75',
      currency: 'BRL',
    });
    expect(typeof response.body.balance.amount).toBe('string');
    expect(response.body.version).toBe(1);
    expect(response.body.createdAt).toBeDefined();
    expect(response.body.updatedAt).toBeDefined();
  });

  it('deve retornar 404 quando a carteira nÃ£o existir', async () => {
    const response = await request(app.getHttpServer())
      .get(`/wallets/${randomUUID()}`)
      .expect(404);

    expect(response.body.code).toBe('WALLET_NOT_FOUND');
    expect(response.body.message).toBe('Carteira não encontrada.');
  });

  it('deve retornar 400 quando o UUID da carteira for invÃ¡lido', async () => {
    await request(app.getHttpServer())
      .get('/wallets/uuid-invalido')
      .expect(400);
  });

  it('deve retornar o extrato vazio de uma carteira', async () => {
    const wallet = await createWallet.execute({
      playerId: `ledger-empty-${randomUUID()}`,
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger`)
      .expect(200);

    expect(response.body).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('deve retornar 404 no extrato quando a carteira não existir', async () => {
    const response = await request(app.getHttpServer())
      .get(`/wallets/${randomUUID()}/ledger`)
      .expect(404);

    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  it('deve retornar 400 quando o cursor do extrato for inválido', async () => {
    const wallet = await createWallet.execute({
      playerId: `ledger-cursor-${randomUUID()}`,
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?cursor=cursor-invalido`)
      .expect(400);

    expect(response.body.code).toBe('INVALID_LEDGER_CURSOR');
  });

  it('deve rejeitar limites inválidos no extrato', async () => {
    const wallet = await createWallet.execute({
      playerId: `ledger-limit-${randomUUID()}`,
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    for (const limit of ['abc', '1.5', '0', '101']) {
      const response = await request(app.getHttpServer())
        .get(`/wallets/${wallet.id}/ledger?limit=${limit}`)
        .expect(400);

      expect(response.body.code).toBe('INVALID_LEDGER_LIMIT');
    }
  });

  it('deve paginar o extrato sem repetir lançamentos', async () => {
    const uniqueId = randomUUID();
    const playerId = `ledger-pagination-${uniqueId}`;
    const providerId = `ledger-pagination-provider-${uniqueId}`;

    const wallet = await createWallet.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const createWin = (suffix: string, amount: string) =>
      processWager.execute({
        providerId,
        externalTransactionId: `win-${uniqueId}-${suffix}`,
        idempotencyKey: `idem-${uniqueId}-${suffix}`,
        playerId,
        walletId: wallet.id,
        roundId: `round-${uniqueId}`,
        gameId: 'integration-pagination-test',
        kind: 'WIN',
        money: {
          amount,
          currency: 'BRL',
        },
      });

    await createWin('first', '10.00');
    await createWin('second', '20.00');

    const firstPage = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=2`)
      .expect(200);

    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app.getHttpServer())
      .get(
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
      )
      .expect(200);

    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();

    const allItems = [
      ...firstPage.body.items,
      ...secondPage.body.items,
    ];

    expect(allItems).toHaveLength(3);

    const ids = allItems.map((item: { id: string }) => item.id);

    expect(new Set(ids).size).toBe(3);

    for (const item of allItems) {
      expect(typeof item.amount).toBe('string');
      expect(item.walletId).toBe(wallet.id);
    }
  });
});
