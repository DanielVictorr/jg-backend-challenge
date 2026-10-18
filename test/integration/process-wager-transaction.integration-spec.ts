
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { calculateWagerPayloadHash } from '../../src/application/wagering/canonical-payload.js';
import { WalletEntity } from '../../src/database/entities/wallet.entity.js';
import { LedgerEntryEntity } from '../../src/database/entities/ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/database/entities/wager-transaction.entity.js';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';

describe('ProcessWagerTransaction — integração PostgreSQL', () => {
  let dataSource: DataSource;
  let createWallet: CreateWallet;
  let processWager: ProcessWagerTransaction;

  
it('deve rejeitar REFUND quando o jogador da referência for incompatível', async () => {
  const { wallet, transaction } = await createScenario();

  const bet = transaction('bet-player-mismatch', 'BET', '20.00');
  const betResult = await processWager.execute(bet);

  expect(betResult.status).toBe('PROCESSED');

  await dataSource.getRepository(WagerTransactionEntity).update(
    {
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
    },
    { playerId: 'different-player' },
  );

  const refund = await processWager.execute(
    transaction(
      'refund-player-mismatch',
      'REFUND',
      '20.00',
      bet.externalTransactionId,
    ),
  );

  expect(refund.status).toBe('REJECTED');
  expect(refund.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('80.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(2);
});

it('deve rejeitar REFUND quando a carteira da referência for incompatível', async () => {
  const { wallet, transaction } = await createScenario();
  const otherScenario = await createScenario();

  const bet = transaction('bet-wallet-mismatch', 'BET', '20.00');
  const betResult = await processWager.execute(bet);

  expect(betResult.status).toBe('PROCESSED');

  await dataSource.getRepository(WagerTransactionEntity).update(
    {
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
    },
    { walletId: otherScenario.wallet.id },
  );

  const refund = await processWager.execute(
    transaction(
      'refund-wallet-mismatch',
      'REFUND',
      '20.00',
      bet.externalTransactionId,
    ),
  );

  expect(refund.status).toBe('REJECTED');
  expect(refund.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('80.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(2);
});

it('deve rejeitar REFUND quando a moeda da referência for incompatível', async () => {
  const { wallet, transaction } = await createScenario();

  const bet = transaction('bet-currency-mismatch', 'BET', '20.00');
  const betResult = await processWager.execute(bet);

  expect(betResult.status).toBe('PROCESSED');

  await dataSource.getRepository(WagerTransactionEntity).update(
    {
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
    },
    { currency: 'USD' },
  );

  const refund = await processWager.execute(
    transaction(
      'refund-currency-mismatch',
      'REFUND',
      '20.00',
      bet.externalTransactionId,
    ),
  );

  expect(refund.status).toBe('REJECTED');
  expect(refund.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('80.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(2);
});


  beforeAll(async () => {
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
      entities: [WalletEntity, LedgerEntryEntity, WagerTransactionEntity],
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

  const createScenario = async (initialBalance = '100.00') => {
    const uniqueId = randomUUID();
    const playerId = `integration-${uniqueId}`;
    const providerId = `provider-${uniqueId}`;

    const wallet = await createWallet.execute({
      playerId,
      initialBalance: {
        amount: initialBalance,
        currency: 'BRL',
      },
    });

    const transaction = (
      suffix: string,
      kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
      amount: string,
      referenceExternalTransactionId?: string,
    ) => ({
      providerId,
      externalTransactionId: `${suffix}-${uniqueId}`,
      idempotencyKey: `idem-${suffix}-${uniqueId}`,
      playerId,
      walletId: wallet.id,
      roundId: `round-${uniqueId}`,
      gameId: 'integration-test',
      kind,
      money: {
        amount,
        currency: 'BRL',
      },
      ...(referenceExternalTransactionId
        ? { referenceExternalTransactionId }
        : {}),
    });

    return { uniqueId, wallet, transaction };
  };

    it('deve processar BET, debitar a carteira e persistir ledger e eventos', async () => {
    const { wallet, transaction } = await createScenario();

    const betInput = transaction('bet-normal', 'BET', '30.00');
    const result = await processWager.execute(betInput);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance.amount).toBe('70.00');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('70.00');
    expect(persistedWallet.version).toBe(2);

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);

    const betEntry = ledgerEntries.find(
      (entry) => entry.transactionId === result.transactionId,
    );

    expect(betEntry).toBeDefined();
    expect(betEntry?.entryType).toBe('DEBIT');
    expect(betEntry?.amount).toBe('30.00');
    expect(betEntry?.balanceBefore).toBe('100.00');
    expect(betEntry?.balanceAfter).toBe('70.00');

    const processedEvents = await dataSource.query(
      `SELECT id
       FROM outbox_events
       WHERE aggregate_id = $1
         AND event_type = $2
         AND payload->>'correlationId' = $3`,
      [wallet.id, 'WagerTransactionProcessed', result.transactionId],
    );

    expect(processedEvents).toHaveLength(1);

    const balanceChangedEvents = await dataSource.query(
      `SELECT
        id,
        payload->'data'->>'walletVersion' AS wallet_version
      FROM outbox_events
      WHERE aggregate_id = $1
        AND event_type = $2
        AND payload->>'correlationId' = $3`,
      [wallet.id, 'WalletBalanceChanged', result.transactionId],
    );

    expect(balanceChangedEvents).toHaveLength(1);
    expect(balanceChangedEvents[0].wallet_version).toBe('2');
  });

  it('deve processar WIN, creditar a carteira e persistir ledger e eventos', async () => {
    const { wallet, transaction } = await createScenario();

    const winInput = transaction('win-normal', 'WIN', '30.00');
    const result = await processWager.execute(winInput);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance.amount).toBe('130.00');
    

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('130.00');
    expect(persistedWallet.version).toBe(2);

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);

    const winEntry = ledgerEntries.find(
      (entry) => entry.transactionId === result.transactionId,
    );

    expect(winEntry).toBeDefined();
    expect(winEntry?.entryType).toBe('CREDIT');
    expect(winEntry?.amount).toBe('30.00');
    expect(winEntry?.balanceBefore).toBe('100.00');
    expect(winEntry?.balanceAfter).toBe('130.00');

    const processedEvents = await dataSource.query(
      `SELECT id
       FROM outbox_events
       WHERE aggregate_id = $1
         AND event_type = $2
         AND payload->>'correlationId' = $3`,
      [wallet.id, 'WagerTransactionProcessed', result.transactionId],
    );

    expect(processedEvents).toHaveLength(1);

    const balanceChangedEvents = await dataSource.query(
      `SELECT
        id,
        payload->'data'->>'walletVersion' AS wallet_version
      FROM outbox_events
      WHERE aggregate_id = $1
        AND event_type = $2
        AND payload->>'correlationId' = $3`,
      [wallet.id, 'WalletBalanceChanged', result.transactionId],
    );

    expect(balanceChangedEvents).toHaveLength(1);
    expect(balanceChangedEvents[0].wallet_version).toBe('2');
  });
  
  it('deve processar LOSS sem alterar saldo, ledger ou evento de mudança de saldo', async () => {
    const { wallet, transaction } = await createScenario();

    const walletRepository = dataSource.getRepository(WalletEntity);
    const ledgerRepository = dataSource.getRepository(LedgerEntryEntity);

    const countOutboxEvents = async (
      eventType: string,
    ): Promise<number> => {
      const rows = await dataSource.query(
        `
          SELECT COUNT(*)::int AS count
          FROM outbox_events
          WHERE aggregate_id = $1
            AND event_type = $2
        `,
        [wallet.id, eventType],
      );

      return Number(rows[0].count);
    };

    const initialWallet = await walletRepository.findOneByOrFail({
      id: wallet.id,
    });
    const initialLedgerCount = await ledgerRepository.count({
      where: { walletId: wallet.id },
    });
    const initialProcessedEvents = await countOutboxEvents(
      'WagerTransactionProcessed',
    );
    const initialBalanceChangedEvents = await countOutboxEvents(
      'WalletBalanceChanged',
    );

    const lossInput = transaction('loss-no-balance-change', 'LOSS', '10.00');
    const result = await processWager.execute(lossInput);

    expect(result.status).toBe('PROCESSED');
    expect(result.kind).toBe('LOSS');
    expect(result.balance.amount).toBe(initialWallet.balance);

    const persistedWallet = await walletRepository.findOneByOrFail({
      id: wallet.id,
    });

    expect(persistedWallet.balance).toBe(initialWallet.balance);
    expect(persistedWallet.version).toBe(initialWallet.version);

    const finalLedgerCount = await ledgerRepository.count({
      where: { walletId: wallet.id },
    });

    expect(finalLedgerCount).toBe(initialLedgerCount);

    const persistedTransaction = await dataSource
      .getRepository(WagerTransactionEntity)
      .findOneByOrFail({
        externalTransactionId: lossInput.externalTransactionId,
      });

    expect(persistedTransaction.status).toBe('PROCESSED');

    const finalProcessedEvents = await countOutboxEvents(
      'WagerTransactionProcessed',
    );
    const finalBalanceChangedEvents = await countOutboxEvents(
      'WalletBalanceChanged',
    );

    expect(finalProcessedEvents).toBe(initialProcessedEvents + 1);
    expect(finalBalanceChangedEvents).toBe(initialBalanceChangedEvents);
  });


  it('deve impedir saldo negativo em duas apostas concorrentes', async () => {
    const { uniqueId, wallet, transaction } = await createScenario();

    const results = await Promise.all([
      processWager.execute(transaction('bet-a', 'BET', '80.00')),
      processWager.execute(transaction('bet-b', 'BET', '80.00')),
    ]);

    expect(
      results.filter((result) => result.status === 'PROCESSED'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'REJECTED'),
    ).toHaveLength(1);

    const rejected = results.find((result) => result.status === 'REJECTED');

    expect(rejected?.failureCode).toBe('INSUFFICIENT_FUNDS');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('20.00');
    expect(persistedWallet.version).toBe(2);

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({
        where: { walletId: wallet.id },
        order: { createdAt: 'ASC' },
      });

    expect(ledgerEntries).toHaveLength(2);

    expect(
      ledgerEntries.filter((entry) => entry.entryType === 'DEBIT'),
    ).toHaveLength(1);

    const openingCredit = ledgerEntries.find(
      (entry) => entry.entryType === 'CREDIT',
    );

    const betDebit = ledgerEntries.find((entry) => entry.entryType === 'DEBIT');

    expect(openingCredit?.amount).toBe('100.00');
    expect(openingCredit?.balanceBefore).toBe('0.00');
    expect(openingCredit?.balanceAfter).toBe('100.00');

    expect(betDebit?.amount).toBe('80.00');
    expect(betDebit?.balanceBefore).toBe('100.00');
    expect(betDebit?.balanceAfter).toBe('20.00');

    const amountToCents = (amount: string): bigint => {
      const [integerPart, decimalPart = ''] = amount.split('.');
      return BigInt(integerPart) * 100n + BigInt(decimalPart.padEnd(2, '0'));
    };

    const reconstructedBalance = ledgerEntries.reduce((balance, entry) => {
      const cents = amountToCents(entry.amount);

      return entry.entryType === 'CREDIT' ? balance + cents : balance - cents;
    }, 0n);

    expect(reconstructedBalance).toBe(amountToCents(persistedWallet.balance));

    const persistedBets = await dataSource
      .getRepository(WagerTransactionEntity)
      .find({
        where: { providerId: `provider-${uniqueId}` },
      });

    expect(persistedBets).toHaveLength(2);
  });

  it('deve processar 50 requisições idênticas em paralelo sem duplicar o débito', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet-50-parallel', 'BET', '10.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(bet)),
    );

    expect(results).toHaveLength(50);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);

    expect(
      results.filter((result) => result.idempotentReplay === false),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.idempotentReplay === true),
    ).toHaveLength(49);

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('90.00');
    expect(persistedWallet.version).toBe(2);

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);

    expect(
      ledgerEntries.filter((entry) => entry.entryType === 'DEBIT'),
    ).toHaveLength(1);

    const persistedTransactions = await dataSource
      .getRepository(WagerTransactionEntity)
      .find({
        where: {
          externalTransactionId: bet.externalTransactionId,
        },
      });

    expect(persistedTransactions).toHaveLength(1);

    
    const originalResult = results.find(
      (result) => result.idempotentReplay === false,
    );

    expect(originalResult).toBeDefined();

    if (!originalResult) {
      throw new Error('A execução original da aposta não foi encontrada');
    }

    const processedEvents = await dataSource.query(
      `SELECT id
       FROM outbox_events
       WHERE aggregate_id = $1
         AND event_type = $2
         AND payload->>'correlationId' = $3`,
      [wallet.id, 'WagerTransactionProcessed', originalResult.transactionId],
    );

    expect(processedEvents).toHaveLength(1);

    const balanceChangedEvents = await dataSource.query(
      `SELECT
         id,
         payload->'data'->>'walletVersion' AS wallet_version
       FROM outbox_events
       WHERE aggregate_id = $1
         AND event_type = $2
         AND payload->>'correlationId' = $3`,
      [wallet.id, 'WalletBalanceChanged', originalResult.transactionId],
    );

    expect(balanceChangedEvents).toHaveLength(1);
    expect(balanceChangedEvents[0].wallet_version).toBe('2');

  });
  it('deve rejeitar payloads diferentes concorrentes com a mesma chave de idempotência', async () => {
  const { wallet, transaction } = await createScenario();

  const originalBet = transaction('bet-idempotency-race', 'BET', '10.00');

  const conflictingBet = {
    ...originalBet,
    money: {
      amount: '20.00',
      currency: 'BRL',
    },
  };

  const results = await Promise.allSettled([
    processWager.execute(originalBet),
    processWager.execute(conflictingBet),
  ]);

  const successfulResults = results.filter(
    (result) => result.status === 'fulfilled',
  );

  const rejectedResults = results.filter(
    (result) => result.status === 'rejected',
  );

  expect(successfulResults).toHaveLength(1);
  expect(rejectedResults).toHaveLength(1);

  const rejectedResult = rejectedResults[0];

  if (!rejectedResult || rejectedResult.status !== 'rejected') {
    throw new Error('A requisição conflitante deveria ter sido rejeitada');
  }

  expect(rejectedResult.reason).toMatchObject({
    response: {
      code: 'IDEMPOTENCY_KEY_REUSED',
    },
  });

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  const persistedTransactions = await dataSource
    .getRepository(WagerTransactionEntity)
    .find({
      where: {
        providerId: originalBet.providerId,
        idempotencyKey: originalBet.idempotencyKey,
      },
    });

  expect(persistedTransactions).toHaveLength(1);
  expect(ledgerEntries.filter((entry) => entry.entryType === 'DEBIT')).toHaveLength(1);
  expect(persistedWallet.balance).toBe('90.00');
});

  it('deve rejeitar a repetição quando o resultado armazenado estiver ausente', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet-missing-snapshot', 'BET', '10.00');

    const firstResult = await processWager.execute(bet);

    expect(firstResult.status).toBe('PROCESSED');

    await dataSource.query(
      `UPDATE wagering_transactions
       SET response_snapshot = NULL
       WHERE id = $1`,
      [firstResult.transactionId],
    );

    await expect(processWager.execute(bet)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'TRANSACTION_RESULT_UNAVAILABLE',
      },
    });

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('90.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);

    const persistedTransaction = await dataSource
      .getRepository(WagerTransactionEntity)
      .findOneByOrFail({
        externalTransactionId: bet.externalTransactionId,
      });

    expect(persistedTransaction.responseSnapshot).toBeNull();
  });

  it('deve processar REFUND e creditar a carteira', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet', 'BET', '30.00');
    await processWager.execute(bet);

    const refund = await processWager.execute(
      transaction('refund', 'REFUND', '30.00', bet.externalTransactionId),
    );

    expect(refund.status).toBe('PROCESSED');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(3);
  });

  it('deve processar ROLLBACK de BET e creditar a carteira', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet', 'BET', '25.00');
    await processWager.execute(bet);

    const rollback = await processWager.execute(
      transaction('rollback', 'ROLLBACK', '25.00', bet.externalTransactionId),
    );

    expect(rollback.status).toBe('PROCESSED');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(3);

    const rollbackEntry = ledgerEntries.find(
      (entry) => entry.transactionId === rollback.transactionId,
    );

    expect(rollbackEntry?.entryType).toBe('CREDIT');
    expect(rollbackEntry?.amount).toBe('25.00');
  });

    it('deve rejeitar ROLLBACK de WIN que causaria saldo negativo', async () => {
    const { wallet, transaction } = await createScenario();

    const win = transaction('win-before-negative-rollback', 'WIN', '80.00');
    const winResult = await processWager.execute(win);

    expect(winResult.status).toBe('PROCESSED');
    expect(winResult.balance.amount).toBe('180.00');

    const bet = transaction('bet-before-negative-rollback', 'BET', '150.00');
    const betResult = await processWager.execute(bet);

    expect(betResult.status).toBe('PROCESSED');
    expect(betResult.balance.amount).toBe('30.00');

    const rollbackInput = transaction(
      'rollback-win-negative-balance',
      'ROLLBACK',
      '80.00',
      win.externalTransactionId,
    );
    rollbackInput.roundId = win.roundId;

    const rollback = await processWager.execute(rollbackInput);

    expect(rollback.status).toBe('REJECTED');
    expect(rollback.failureCode).toBe(
      'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
    );
    expect(rollback.balance.amount).toBe('30.00');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('30.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    // OPENING + WIN + BET. O ROLLBACK rejeitado não pode criar lançamento.
    expect(ledgerEntries).toHaveLength(3);

    const rollbackEntry = ledgerEntries.find(
      (entry) => entry.transactionId === rollback.transactionId,
    );

    expect(rollbackEntry).toBeUndefined();

    const rejectedEvents = await dataSource.query(
      `SELECT id
       FROM outbox_events
       WHERE aggregate_id = $1
         AND event_type = $2
         AND payload->>'correlationId' = $3`,
      [wallet.id, 'WagerTransactionRejected', rollback.transactionId],
    );

    expect(rejectedEvents).toHaveLength(1);

    const balanceChangedEvents = await dataSource.query(
      `SELECT id
       FROM outbox_events
       WHERE aggregate_id = $1
         AND event_type = $2
         AND payload->>'correlationId' = $3`,
      [wallet.id, 'WalletBalanceChanged', rollback.transactionId],
    );

    expect(balanceChangedEvents).toHaveLength(0);
  });

  it('deve processar ROLLBACK de WIN e debitar o prêmio', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet-before-win-rollback', 'BET', '25.00');
    await processWager.execute(bet);

    const win = transaction('win-to-rollback', 'WIN', '10.00');
    win.roundId = bet.roundId;

    const winResult = await processWager.execute(win);
    expect(winResult.status).toBe('PROCESSED');

    const rollbackInput = transaction(
      'rollback-win',
      'ROLLBACK',
      '10.00',
      win.externalTransactionId,
    );
    rollbackInput.roundId = win.roundId;

    const rollback = await processWager.execute(rollbackInput);

    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.balance.amount).toBe('75.00');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    // 100 - 25 da BET + 10 do WIN - 10 do ROLLBACK.
    expect(persistedWallet.balance).toBe('75.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(4);

    const rollbackEntry = ledgerEntries.find(
      (entry) => entry.transactionId === rollback.transactionId,
    );

    expect(rollbackEntry?.entryType).toBe('DEBIT');
    expect(rollbackEntry?.amount).toBe('10.00');
  });

  it('deve processar ROLLBACK de REFUND e debitar o reembolso', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet-before-refund-rollback', 'BET', '25.00');
    await processWager.execute(bet);

    const refundInput = transaction(
      'refund-to-rollback',
      'REFUND',
      '25.00',
      bet.externalTransactionId,
    );
    refundInput.roundId = bet.roundId;

    const refund = await processWager.execute(refundInput);
    expect(refund.status).toBe('PROCESSED');

    const rollbackInput = transaction(
      'rollback-refund',
      'ROLLBACK',
      '25.00',
      refundInput.externalTransactionId,
    );
    rollbackInput.roundId = refundInput.roundId;

    const rollback = await processWager.execute(rollbackInput);

    expect(rollback.status).toBe('PROCESSED');
    expect(rollback.balance.amount).toBe('75.00');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    // 100 - 25 da BET + 25 do REFUND - 25 do ROLLBACK.
    expect(persistedWallet.balance).toBe('75.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(4);

    const rollbackEntry = ledgerEntries.find(
      (entry) => entry.transactionId === rollback.transactionId,
    );

    expect(rollbackEntry?.entryType).toBe('DEBIT');
    expect(rollbackEntry?.amount).toBe('25.00');
  });

  it('deve manter REFUND pendente quando a referência não existe', async () => {
    const { wallet, transaction } = await createScenario();

    const refund = await processWager.execute(
      transaction(
        'refund',
        'REFUND',
        '20.00',
        `bet-inexistente-${randomUUID()}`,
      ),
    );

    expect(refund.status).toBe('PENDING_REFERENCE');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(1);
  });

  it('deve rejeitar REFUND com valor diferente da aposta', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet', 'BET', '30.00');
    await processWager.execute(bet);

    const refund = await processWager.execute(
      transaction('refund', 'REFUND', '20.00', bet.externalTransactionId),
    );

    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('70.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);
  });

  it('deve rejeitar REFUND quando a referência pertence a outra rodada', async () => {
  const { wallet, transaction } = await createScenario();

  const bet = transaction('bet-other-round', 'BET', '20.00');
  const betResult = await processWager.execute(bet);

  expect(betResult.status).toBe('PROCESSED');

  const refundInput = {
    ...transaction(
      'refund-other-round',
      'REFUND',
      '20.00',
      bet.externalTransactionId,
    ),
    roundId: 'different-round',
  };

  const refund = await processWager.execute(refundInput);

  expect(refund.status).toBe('REJECTED');
  expect(refund.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('80.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(2);
});

it('deve rejeitar REFUND cuja referência seja WIN', async () => {
  const { wallet, transaction } = await createScenario();

  const win = transaction('win-invalid-refund', 'WIN', '20.00');
  const winResult = await processWager.execute(win);

  expect(winResult.status).toBe('PROCESSED');

  const refund = await processWager.execute(
    transaction(
      'refund-invalid-kind',
      'REFUND',
      '20.00',
      win.externalTransactionId,
    ),
  );

  expect(refund.status).toBe('REJECTED');
  expect(refund.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('120.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(2);
});

it('deve rejeitar ROLLBACK cuja referência seja LOSS', async () => {
  const { wallet, transaction } = await createScenario();

  const loss = transaction('loss-invalid-rollback', 'LOSS', '20.00');
  const lossResult = await processWager.execute(loss);

  expect(lossResult.status).toBe('PROCESSED');

  const rollback = await processWager.execute(
    transaction(
      'rollback-invalid-kind',
      'ROLLBACK',
      '20.00',
      loss.externalTransactionId,
    ),
  );

  expect(rollback.status).toBe('REJECTED');
  expect(rollback.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('100.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(1);
});

it('deve rejeitar REFUND cuja referência não esteja processada', async () => {
  const { wallet, transaction } = await createScenario();

  const bet = transaction('bet-rejected-reference', 'BET', '200.00');
  const betResult = await processWager.execute(bet);

  expect(betResult.status).toBe('REJECTED');

  const refund = await processWager.execute(
    transaction(
      'refund-rejected-reference',
      'REFUND',
      '200.00',
      bet.externalTransactionId,
    ),
  );

  expect(refund.status).toBe('REJECTED');
  expect(refund.failureCode).toBe('INVALID_REFERENCE');

  const persistedWallet = await dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ id: wallet.id });

  expect(persistedWallet.balance).toBe('100.00');

  const ledgerEntries = await dataSource
    .getRepository(LedgerEntryEntity)
    .find({ where: { walletId: wallet.id } });

  expect(ledgerEntries).toHaveLength(1);
}); 

  it('deve rejeitar uma segunda reversão do mesmo tipo', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet', 'BET', '30.00');
    await processWager.execute(bet);

    const firstRefund = await processWager.execute(
      transaction('refund-a', 'REFUND', '30.00', bet.externalTransactionId),
    );

    expect(firstRefund.status).toBe('PROCESSED');

    const secondRefund = await processWager.execute(
      transaction('refund-b', 'REFUND', '30.00', bet.externalTransactionId),
    );

    expect(secondRefund.status).toBe('REJECTED');
    expect(secondRefund.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(3);
  });

  it('deve impedir duas reversões concorrentes da mesma aposta', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('bet-concurrent-reversal', 'BET', '30.00');
    const betResult = await processWager.execute(bet);

    expect(betResult.status).toBe('PROCESSED');

    const [firstRefund, secondRefund] = await Promise.all([
      processWager.execute(
        transaction(
          'refund-concurrent-a',
          'REFUND',
          '30.00',
          bet.externalTransactionId,
        ),
      ),
      processWager.execute(
        transaction(
          'refund-concurrent-b',
          'REFUND',
          '30.00',
          bet.externalTransactionId,
        ),
      ),
    ]);

    const results = [firstRefund, secondRefund];
    const processedRefunds = results.filter(
      (result) => result.status === 'PROCESSED',
    );
    const rejectedRefunds = results.filter(
      (result) => result.status === 'REJECTED',
    );

    expect(processedRefunds).toHaveLength(1);
    expect(rejectedRefunds).toHaveLength(1);
    expect(rejectedRefunds[0].failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(3);

    const persistedRefunds = await dataSource
      .getRepository(WagerTransactionEntity)
      .find({
        where: {
          referenceTransactionId: betResult.transactionId,
          kind: 'REFUND',
          status: 'PROCESSED',
        },
      });

    expect(persistedRefunds).toHaveLength(1);
  });

  it('deve impedir UPDATE em um lançamento do ledger', async () => {
    const { wallet, transaction } = await createScenario();

    await processWager.execute(transaction('bet-immutability', 'BET', '10.00'));

    const repository = dataSource.getRepository(LedgerEntryEntity);
    const entry = await repository.findOneByOrFail({
      walletId: wallet.id,
      entryType: 'DEBIT',
    });

    await expect(
      dataSource.query(`UPDATE ledger_entries SET amount = $1 WHERE id = $2`, [
        '1.00',
        entry.id,
      ]),
    ).rejects.toThrow();

    const persistedEntry = await repository.findOneByOrFail({
      id: entry.id,
    });

    expect(persistedEntry.amount).toBe('10.00');
  });

  it('deve impedir DELETE de um lançamento do ledger', async () => {
    const { wallet, transaction } = await createScenario();

    await processWager.execute(
      transaction('bet-delete-immutability', 'BET', '10.00'),
    );

    const repository = dataSource.getRepository(LedgerEntryEntity);
    const entry = await repository.findOneByOrFail({
      walletId: wallet.id,
      entryType: 'DEBIT',
    });

    await expect(
      dataSource.query(`DELETE FROM ledger_entries WHERE id = $1`, [entry.id]),
    ).rejects.toThrow();

    const persistedEntry = await repository.findOneByOrFail({
      id: entry.id,
    });

    expect(persistedEntry.id).toBe(entry.id);
    expect(persistedEntry.amount).toBe('10.00');
  });

  it('deve impedir TRUNCATE da tabela do ledger', async () => {
    const { transaction } = await createScenario();

    await processWager.execute(
      transaction('bet-truncate-immutability', 'BET', '10.00'),
    );

    const repository = dataSource.getRepository(LedgerEntryEntity);
    const before = await repository.count();

    expect(before).toBeGreaterThan(0);

    await expect(
      dataSource.query(`TRUNCATE TABLE ledger_entries`),
    ).rejects.toThrow();

    const after = await repository.count();

    expect(after).toBe(before);
  });

  it('deve processar uma reversão pendente quando a referência aparecer', async () => {
    const { wallet, transaction } = await createScenario();

    const lateReferenceExternalId = `late-bet-${randomUUID()}`;

    // A referência ainda não existe: o REFUND deve ficar pendente.
    const refundInput = transaction(
      'refund-late-reference',
      'REFUND',
      '30.00',
      lateReferenceExternalId,
    );

    const pendingRefund = await processWager.execute(refundInput);

    expect(pendingRefund.status).toBe('PENDING_REFERENCE');

    // A aposta chega depois, usando a mesma carteira, rodada e referência externa.
    const betInput = transaction('bet-late-reference', 'BET', '30.00');

    betInput.externalTransactionId = lateReferenceExternalId;
    betInput.roundId = refundInput.roundId;

    const betResult = await processWager.execute(betInput);

    expect(betResult.status).toBe('PROCESSED');

    // Torna a retentativa elegível sem esperar o intervalo de polling.
    await dataSource.query(
      `
        UPDATE wagering_transactions
        SET reference_next_retry_at = NOW() - INTERVAL '1 second'
        WHERE provider_id = $1
          AND external_transaction_id = $2
      `,
      [refundInput.providerId, refundInput.externalTransactionId],
    );

    const worker = new RetryPendingReferences(dataSource);
    await worker.processDueReferences();

    const persistedRefund = await dataSource
      .getRepository(WagerTransactionEntity)
      .findOneByOrFail({
        providerId: refundInput.providerId,
        externalTransactionId: refundInput.externalTransactionId,
      });

    expect(persistedRefund.status).toBe('PROCESSED');
    expect(persistedRefund.referenceTransactionId).toBe(
      betResult.transactionId,
    );

    expect(persistedRefund.responseSnapshot).toMatchObject({
      transactionId: pendingRefund.transactionId,
      walletId: wallet.id,
      status: 'PROCESSED',
      kind: 'REFUND',
      balance: {
        amount: '100.00',
        currency: 'BRL',
      },
      idempotentReplay: false,
    });

    // Repetir a requisição original deve retornar o estado final persistido.
    const replayedRefund = await processWager.execute(refundInput);

    expect(replayedRefund.status).toBe('PROCESSED');
    expect(replayedRefund.transactionId).toBe(pendingRefund.transactionId);
    expect(replayedRefund.balance.amount).toBe('100.00');
    expect(replayedRefund.idempotentReplay).toBe(true);

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    // Saldo inicial 100 - aposta 30 + reembolso 30.
    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(3);

    // Verifica os eventos da Outbox gerados durante o processamento.
    const [outboxCounts] = await dataSource.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE event_type = 'WagerTransactionPendingReference'
          )::int AS pending_count,
          COUNT(*) FILTER (
            WHERE event_type = 'WagerTransactionProcessed'
          )::int AS processed_count,
          COUNT(*) FILTER (
            WHERE event_type = 'WalletBalanceChanged'
          )::int AS balance_changed_count
        FROM outbox_events
        WHERE aggregate_id = $1
      `,
      [wallet.id],
    );

    expect(outboxCounts).toMatchObject({
      pending_count: 1,
      processed_count: 3,
      balance_changed_count: 3,
    });
  });

  it('deve rejeitar uma referência não encontrada após a expiração', async () => {
    const { wallet, transaction } = await createScenario();

    const refundInput = transaction(
      'refund-expired-reference',
      'REFUND',
      '25.00',
      `missing-bet-${randomUUID()}`,
    );

    const result = await processWager.execute(refundInput);

    expect(result.status).toBe('PENDING_REFERENCE');

    // Simula a expiração sem aguardar 24 horas.
    await dataSource.query(
      `
        UPDATE wagering_transactions
        SET reference_next_retry_at = NOW() - INTERVAL '1 second',
            reference_expires_at = NOW() - INTERVAL '1 second'
        WHERE provider_id = $1
          AND external_transaction_id = $2
      `,
      [refundInput.providerId, refundInput.externalTransactionId],
    );

    const worker = new RetryPendingReferences(dataSource);
    await worker.processDueReferences();

    const persistedRefund = await dataSource
      .getRepository(WagerTransactionEntity)
      .findOneByOrFail({
        providerId: refundInput.providerId,
        externalTransactionId: refundInput.externalTransactionId,
      });

    expect(persistedRefund.status).toBe('REJECTED');
    expect(persistedRefund.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(persistedRefund.referenceNextRetryAt).toBeNull();

    expect(persistedRefund.responseSnapshot).toMatchObject({
      transactionId: result.transactionId,
      walletId: wallet.id,
      status: 'REJECTED',
      kind: 'REFUND',
      balance: {
        amount: '100.00',
        currency: 'BRL',
      },
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: false,
    });

    // A repetição deve refletir a rejeição persistida.
    const replayedRefund = await processWager.execute(refundInput);

    expect(replayedRefund.status).toBe('REJECTED');
    expect(replayedRefund.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(replayedRefund.balance.amount).toBe('100.00');
    expect(replayedRefund.idempotentReplay).toBe(true);

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    // Nenhum lançamento financeiro deve ser criado pelo REFUND rejeitado.
    expect(ledgerEntries).toHaveLength(1);

    const [outboxCounts] = await dataSource.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE event_type = 'WagerTransactionPendingReference'
          )::int AS pending_count,
          COUNT(*) FILTER (
            WHERE event_type = 'WagerTransactionRejected'
          )::int AS rejected_count,
          COUNT(*) FILTER (
            WHERE event_type = 'WalletBalanceChanged'
          )::int AS balance_changed_count
        FROM outbox_events
        WHERE aggregate_id = $1
      `,
      [wallet.id],
    );

    expect(outboxCounts).toMatchObject({
      pending_count: 1,
      rejected_count: 1,
      balance_changed_count: 1,
    });
  });

  it('deve preservar os dois registros do Inbox em mensagens concorrentes com a mesma chave de idempotência', async () => {
    const { wallet, transaction } = await createScenario();

    const bet = transaction('inbox-concurrent', 'BET', '10.00');

    const payloadHash = calculateWagerPayloadHash(bet);

    const inboxContextA = {
      consumerName: 'wager-transaction-consumer',
      messageId: `msg-a-${randomUUID()}`,
      payloadHash,
    };

    const inboxContextB = {
      consumerName: 'wager-transaction-consumer',
      messageId: `msg-b-${randomUUID()}`,
      payloadHash,
    };

    const results = await Promise.all([
      processWager.execute(bet, inboxContextA),
      processWager.execute(bet, inboxContextB),
    ]);

    expect(
      results.every(
        (result) =>
          'transactionId' in result &&
          result.status === 'PROCESSED',
      ),
    ).toBe(true);

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('90.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);
    expect(
      ledgerEntries.filter((entry) => entry.entryType === 'DEBIT'),
    ).toHaveLength(1);

    const inboxRows: Array<{
      message_id: string;
      processed_at: Date | null;
    }> = await dataSource.query(
      `SELECT message_id, processed_at
        FROM processed_messages
        WHERE consumer_name = $1
          AND message_id = ANY($2::varchar[])
        ORDER BY message_id`,
      [
        inboxContextA.consumerName,
        [inboxContextA.messageId, inboxContextB.messageId],
      ],
    );

    expect(inboxRows).toHaveLength(2);
    expect(inboxRows.every((row) => row.processed_at !== null)).toBe(true);
  });

  it('deve falhar com erro transitório quando o Inbox existe sem confirmação de processamento', async () => {
    const { wallet, transaction } = await createScenario();
    const bet = transaction('inbox-incomplete', 'BET', '10.00');

    const inboxContext = {
      consumerName: 'wager-transaction-consumer',
      messageId: `msg-${randomUUID()}`,
      payloadHash: 'e'.repeat(64),
    };

    await dataSource.query(
      `INSERT INTO processed_messages
        (consumer_name, message_id, payload_hash, processed_at)
      VALUES ($1, $2, $3, NULL)`,
      [
        inboxContext.consumerName,
        inboxContext.messageId,
        inboxContext.payloadHash,
      ],
    );

    await expect(
      processWager.execute(bet, inboxContext),
    ).rejects.toMatchObject({
      status: 500,
      response: expect.objectContaining({
        code: 'INBOX_MESSAGE_NOT_COMPLETED',
      }),
    });

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const inboxRows: Array<{
      message_id: string;
      processed_at: Date | string | null;
    }> = await dataSource.query(
      `SELECT message_id, processed_at
        FROM processed_messages
        WHERE consumer_name = $1
          AND message_id = $2`,
      [inboxContext.consumerName, inboxContext.messageId],
    );

    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].processed_at).toBeNull();
  });

  it('deve ignorar uma mensagem SQS repetida sem duplicar o débito', async () => {
    const { wallet, transaction } = await createScenario();
    const bet = transaction('inbox-duplicate', 'BET', '10.00');

    const inboxContext = {
      consumerName: 'wager-transaction-consumer',
      messageId: `msg-${randomUUID()}`,
      payloadHash: 'a'.repeat(64),
    };

    const firstResult = await processWager.execute(bet, inboxContext);
    const secondResult = await processWager.execute(bet, inboxContext);

    expect(firstResult).toEqual(
      expect.objectContaining({ status: 'PROCESSED' }),
    );
    expect(secondResult).toEqual({ duplicateMessage: true });

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('90.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    expect(ledgerEntries).toHaveLength(2);

    const inboxRows = await dataSource.query(
      `SELECT message_id
        FROM processed_messages
        WHERE consumer_name = $1
          AND message_id = $2`,
      [inboxContext.consumerName, inboxContext.messageId],
    );

    expect(inboxRows).toHaveLength(1);
  });

  it('deve rejeitar o mesmo messageId com payloadHash diferente', async () => {
    const { wallet, transaction } = await createScenario();
    const bet = transaction('inbox-conflict', 'BET', '10.00');

    const inboxContext = {
      consumerName: 'wager-transaction-consumer',
      messageId: `msg-${randomUUID()}`,
      payloadHash: 'b'.repeat(64),
    };

    await processWager.execute(bet, inboxContext);

    await expect(
      processWager.execute(bet, {
        ...inboxContext,
        payloadHash: 'c'.repeat(64),
      }),
    ).rejects.toThrow();

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('90.00');

    const inboxRows: Array<{ payload_hash: string }> =
      await dataSource.query(
        `SELECT payload_hash
           FROM processed_messages
          WHERE consumer_name = $1
            AND message_id = $2`,
        [inboxContext.consumerName, inboxContext.messageId],
      );

    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].payload_hash).toBe('b'.repeat(64));
  });

  it('deve reverter o registro do Inbox quando o processamento falhar', async () => {
    const { transaction } = await createScenario();
    const bet = transaction('inbox-rollback', 'BET', '10.00');

    const inboxContext = {
      consumerName: 'wager-transaction-consumer',
      messageId: `msg-${randomUUID()}`,
      payloadHash: 'd'.repeat(64),
    };

    // UUID válido, mas inexistente no banco.
    const invalidWalletInput = {
      ...bet,
      walletId: randomUUID(),
    };

    await expect(
      processWager.execute(invalidWalletInput, inboxContext),
    ).rejects.toThrow();

    const inboxRows: Array<{ message_id: string }> =
      await dataSource.query(
        `SELECT message_id
           FROM processed_messages
          WHERE consumer_name = $1
            AND message_id = $2`,
        [inboxContext.consumerName, inboxContext.messageId],
      );

    expect(inboxRows).toHaveLength(0);
  });
  
  it('deve aplicar backoff exponencial e rejeitar após 10 tentativas', async () => {
    const { wallet, transaction } = await createScenario();

    const refundInput = transaction(
      'refund-retry-limit',
      'REFUND',
      '25.00',
      `missing-reference-${randomUUID()}`,
    );

    const result = await processWager.execute(refundInput);

    expect(result.status).toBe('PENDING_REFERENCE');

    const worker = new RetryPendingReferences(dataSource);
    const retryDelaysSeconds = [5, 10, 20, 40, 80, 160, 320, 640, 900];

    for (let attempt = 1; attempt <= 10; attempt++) {
      // Torna a transação elegível sem aguardar o intervalo real.
      await dataSource.query(
        `
          UPDATE wagering_transactions
          SET reference_next_retry_at = NOW() - INTERVAL '1 second',
              reference_expires_at = NOW() + INTERVAL '24 hours'
          WHERE provider_id = $1
            AND external_transaction_id = $2
        `,
        [refundInput.providerId, refundInput.externalTransactionId],
      );

      const startedAt = Date.now();

      await worker.processDueReferences();

      const finishedAt = Date.now();

      const persisted = await dataSource
        .getRepository(WagerTransactionEntity)
        .findOneByOrFail({
          providerId: refundInput.providerId,
          externalTransactionId: refundInput.externalTransactionId,
        });

      expect(persisted.referenceRetryCount).toBe(attempt);

      if (attempt < 10) {
        expect(persisted.status).toBe('PENDING_REFERENCE');
        expect(persisted.referenceNextRetryAt).not.toBeNull();

        const expectedDelayMs =
          retryDelaysSeconds[attempt - 1] * 1_000;

        const actualDelayMs =
          persisted.referenceNextRetryAt!.getTime() - startedAt;

        expect(actualDelayMs).toBeGreaterThanOrEqual(
          expectedDelayMs - 100,
        );
        expect(actualDelayMs).toBeLessThanOrEqual(
          expectedDelayMs + (finishedAt - startedAt) + 1_000,
        );
      } else {
        expect(persisted.status).toBe('REJECTED');
        expect(persisted.failureCode).toBe('REFERENCE_NOT_FOUND');
        expect(persisted.referenceNextRetryAt).toBeNull();
      }
    }

    const persistedWallet = await dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ id: wallet.id });

    expect(persistedWallet.balance).toBe('100.00');

    const ledgerEntries = await dataSource
      .getRepository(LedgerEntryEntity)
      .find({ where: { walletId: wallet.id } });

    // Apenas o lançamento inicial da carteira deve existir.
    expect(ledgerEntries).toHaveLength(1);
  });

});
