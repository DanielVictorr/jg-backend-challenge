
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';

describe('Wallet — integração HTTP', () => {
  let app: INestApplication;
  let createWallet: CreateWallet;

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

  it('deve retornar 404 quando a carteira não existir', async () => {
    const response = await request(app.getHttpServer())
      .get(`/wallets/${randomUUID()}`)
      .expect(404);

    expect(response.body.code).toBe('WALLET_NOT_FOUND');
    expect(response.body.message).toBe('Carteira não encontrada.');
  });

  it('deve retornar 400 quando o UUID da carteira for inválido', async () => {
    await request(app.getHttpServer())
      .get('/wallets/uuid-invalido')
      .expect(400);
  });
});
