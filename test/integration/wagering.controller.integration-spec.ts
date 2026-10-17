
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';

describe('WageringController — integração HTTP', () => {
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

  it('deve retornar 400 quando Idempotency-Key estiver ausente', async () => {
    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send({})
      .expect(400);

    expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('deve processar a aposta uma única vez em caso de repetição', async () => {
    const uniqueId = randomUUID();
    const playerId = `http-integration-${uniqueId}`;
    const providerId = `provider-${uniqueId}`;

    const wallet = await createWallet.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const payload = {
      providerId,
      externalTransactionId: `bet-${uniqueId}`,
      playerId,
      walletId: wallet.id,
      roundId: `round-${uniqueId}`,
      gameId: 'http-integration-test',
      kind: 'BET',
      money: {
        amount: '80.00',
        currency: 'BRL',
      },
    };

    const firstResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `idem-${uniqueId}`)
      .send(payload)
      .expect(201);

    expect(firstResponse.body.status).toBe('PROCESSED');
    expect(firstResponse.body.idempotentReplay).toBe(false);
    expect(firstResponse.body.balance.amount).toBe('20.00');

    const replayResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `idem-${uniqueId}`)
      .send(payload)
      .expect(201);

    expect(replayResponse.body.transactionId).toBe(
      firstResponse.body.transactionId,
    );
    expect(replayResponse.body.idempotentReplay).toBe(true);
    expect(replayResponse.body.balance.amount).toBe('20.00');

    const conflictResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `idem-${uniqueId}`)
      .send({
        ...payload,
        money: {
          amount: '70.00',
          currency: 'BRL',
        },
      })
      .expect(409);

    expect(conflictResponse.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
