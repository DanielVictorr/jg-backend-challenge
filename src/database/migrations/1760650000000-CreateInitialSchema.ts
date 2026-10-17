
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInitialSchema1760650000000
  implements MigrationInterface
{
  name = 'CreateInitialSchema1760650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(100) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT chk_wallets_balance_non_negative
          CHECK (balance >= 0),
        CONSTRAINT chk_wallets_version_positive
          CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency_format
          CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT uq_wallets_player_currency
          UNIQUE (player_id, currency)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE wagering_transactions (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id VARCHAR(100) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        kind VARCHAR(30) NOT NULL,
        status VARCHAR(30) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_transaction_id UUID REFERENCES wagering_transactions(id),
        round_id VARCHAR(255),
        provider_id VARCHAR(100),
        rejection_code VARCHAR(100),
        response_snapshot JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_wagering_idempotency
          UNIQUE (player_id, idempotency_key),
        CONSTRAINT chk_wagering_amount_non_negative
          CHECK (amount >= 0),
        CONSTRAINT chk_wagering_kind
          CHECK (kind IN (
            'OPENING', 'BET', 'WIN', 'LOSS',
            'REFUND', 'ROLLBACK'
          )),
        CONSTRAINT chk_wagering_status
          CHECK (status IN (
            'PENDING', 'PENDING_REFERENCE', 'PROCESSED',
            'REJECTED', 'FAILED'
          ))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wagering_transactions(id),
        entry_type VARCHAR(10) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT chk_ledger_entry_type
          CHECK (entry_type IN ('CREDIT', 'DEBIT')),
        CONSTRAINT chk_ledger_amount_positive
          CHECK (amount > 0),
        CONSTRAINT uq_ledger_transaction_wallet
          UNIQUE (transaction_id, wallet_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE processed_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id UUID PRIMARY KEY,
        aggregate_type VARCHAR(100) NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(150) NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error TEXT,

        CONSTRAINT chk_outbox_attempts_non_negative
          CHECK (attempts >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_wagering_wallet_created
      ON wagering_transactions (wallet_id, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_wagering_reference
      ON wagering_transactions (reference_transaction_id)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_outbox_pending
      ON outbox_events (next_attempt_at, created_at)
      WHERE published_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_events');
    await queryRunner.query('DROP TABLE IF EXISTS processed_messages');
    await queryRunner.query('DROP TABLE IF EXISTS ledger_entries');
    await queryRunner.query('DROP TABLE IF EXISTS wagering_transactions');
    await queryRunner.query('DROP TABLE IF EXISTS wallets');
  }
}
