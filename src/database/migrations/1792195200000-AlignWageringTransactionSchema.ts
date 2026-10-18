import { MigrationInterface, QueryRunner } from 'typeorm';
export class AlignWageringTransactionSchema1792195200000 implements MigrationInterface {
    name = 'AlignWageringTransactionSchema1792195200000';
    public async up(queryRunner: QueryRunner): Promise<void> {
        const [{ hasRows }] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM wagering_transactions
        LIMIT 1
      ) AS "hasRows"
    `);
        if (hasRows) {
            throw new Error('Cannot align wagering_transactions automatically: ' +
                'existing rows require an explicit data migration.');
        }
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        ADD COLUMN external_transaction_id VARCHAR(255) NOT NULL,
        ADD COLUMN game_id VARCHAR(255) NOT NULL,
        ADD COLUMN reference_external_transaction_id VARCHAR(255),
        ADD COLUMN processed_at TIMESTAMPTZ,
        ADD COLUMN reference_next_retry_at TIMESTAMPTZ
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        ALTER COLUMN provider_id SET NOT NULL,
        ALTER COLUMN round_id SET NOT NULL
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        RENAME COLUMN rejection_code TO failure_code
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        DROP CONSTRAINT chk_wagering_amount_non_negative,
        ADD CONSTRAINT chk_wagering_amount_positive
          CHECK (amount > 0)
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        DROP CONSTRAINT uq_wagering_idempotency
    `);
        await queryRunner.query(`
      CREATE UNIQUE INDEX uq_wagering_provider_idempotency
      ON wagering_transactions (provider_id, idempotency_key)
    `);
        await queryRunner.query(`
      CREATE UNIQUE INDEX uq_wagering_provider_external_transaction
      ON wagering_transactions (provider_id, external_transaction_id)
    `);
        await queryRunner.query(`
      CREATE INDEX idx_wagering_provider_reference
      ON wagering_transactions (
        provider_id,
        reference_external_transaction_id
      )
      WHERE reference_external_transaction_id IS NOT NULL
    `);
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      DROP INDEX IF EXISTS idx_wagering_provider_reference
    `);
        await queryRunner.query(`
      DROP INDEX IF EXISTS uq_wagering_provider_external_transaction
    `);
        await queryRunner.query(`
      DROP INDEX IF EXISTS uq_wagering_provider_idempotency
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        DROP CONSTRAINT chk_wagering_amount_positive,
        ADD CONSTRAINT chk_wagering_amount_non_negative
          CHECK (amount >= 0)
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        RENAME COLUMN failure_code TO rejection_code
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        ALTER COLUMN provider_id DROP NOT NULL,
        ALTER COLUMN round_id DROP NOT NULL
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        DROP COLUMN processed_at,
        DROP COLUMN reference_external_transaction_id,
        DROP COLUMN game_id,
        DROP COLUMN external_transaction_id
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        ADD CONSTRAINT uq_wagering_idempotency
          UNIQUE (player_id, idempotency_key)
    `);
    }
}
