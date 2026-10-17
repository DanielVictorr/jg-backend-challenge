
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';

import { WalletEntity } from '../../src/database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../src/database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/database/entities/wager-transaction.entity.js';

import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';

describe('ProcessWagerTransaction — integração PostgreSQL', () => {
  let dataSource: DataSource;
  let createWallet: CreateWallet;
  let processWager: ProcessWagerTransaction;

  beforeAll(async () => {
    // Proteção: este teste só pode acessar o banco de integração.
    if (
      process.env.DB_DATABASE !== 'jg_backend_integration' ||
      process.env.DB_PORT !== '55432'
    ) {
      throw new Error(
        'Teste bloqueado: configure explicitamente o banco jg_backend_integration na porta 55432.',
      );
    }

    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: 55432,
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD,
      database: 'jg_backend_integration',
      entities: [
        WalletEntity,
        LedgerEntryEntity,
        WagerTransactionEntity,
      ],
      synchronize: false,
      migrationsRun: false,
    });

    await dataSource.initialize();

    createWallet = new CreateWallet(dataSource);
    processWager = new ProcessWagerTransaction(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('deve impedir saldo negativo em duas apostas concorrentes', async () => {
    const uniqueId = randomUUID();
    const playerId = `integration-${uniqueId}`;
    const providerId = `provider-${uniqueId}`;

    const wallet = await createWallet.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const createBet = (suffix: string) => ({
      providerId,
      externalTransactionId: `bet-${uniqueId}-${suffix}`,
      idempotencyKey: `idem-${uniqueId}-${suffix}`,
      playerId,
      walletId: wallet.id,
      roundId: `round-${uniqueId}`,
      gameId: 'integration-test',
      kind: 'BET',
      money: {
        amount: '80.00',
        currency: 'BRL',
      },
    });

    const results = await Promise.all([
      processWager.execute(createBet('a')),
      processWager.execute(createBet('b')),
    ]);

    expect(
      results.filter((result) => result.status === 'PROCESSED'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'REJECTED'),
    ).toHaveLength(1);

    const rejected = results.find(
      (result) => result.status === 'REJECTED',
    );

    expect(rejected?.failureCode).toBe('INSUFFICIENT_FUNDS');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('20.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({
        where: { walletId: wallet.id },
        order: { createdAt: 'ASC' },
      });

    // Crédito OPENING + exatamente um débito BET.
    expect(ledgerEntries).toHaveLength(2);

    expect(
      ledgerEntries.filter((entry) => entry.entryType === 'DEBIT'),
    ).toHaveLength(1);

    const openingCredit = ledgerEntries.find(
      (entry) => entry.entryType === 'CREDIT',
    );

    const betDebit = ledgerEntries.find(
      (entry) => entry.entryType === 'DEBIT',
    );

    expect(openingCredit?.amount).toBe('100.00');
    expect(openingCredit?.balanceBefore).toBe('0.00');
    expect(openingCredit?.balanceAfter).toBe('100.00');

    expect(betDebit?.amount).toBe('80.00');
    expect(betDebit?.balanceBefore).toBe('100.00');
    expect(betDebit?.balanceAfter).toBe('20.00');

    // O ledger precisa reconstruir o saldo atual.
    const amountToCents = (amount: string): bigint => {
  const [integerPart, decimalPart = ''] = amount.split('.');
  const cents = decimalPart.padEnd(2, '0');

  return BigInt(integerPart) * 100n + BigInt(cents);
};

    const reconstructedBalance = ledgerEntries.reduce(
      (balance, entry) => {
        const amountInCents = amountToCents(entry.amount);

        return entry.entryType === 'CREDIT'
          ? balance + amountInCents
          : balance - amountInCents;
      },
      0n,
    );

    expect(reconstructedBalance).toBe(2000n);

    const persistedBets = await dataSource
      .getRepository(WagerTransactionEntity)
      .find({
        where: { providerId },
      });

    expect(persistedBets).toHaveLength(2);
  });
});
