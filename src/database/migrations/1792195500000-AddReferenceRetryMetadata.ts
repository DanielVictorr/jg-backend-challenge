import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddReferenceRetryMetadata1792195500000 implements MigrationInterface {
    name = 'AddReferenceRetryMetadata1792195500000';
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        ADD COLUMN reference_retry_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN reference_next_retry_at TIMESTAMPTZ,
        ADD COLUMN reference_expires_at TIMESTAMPTZ
    `);
        await queryRunner.query(`
      UPDATE wagering_transactions
      SET
        reference_next_retry_at = NOW(),
        reference_expires_at = created_at + INTERVAL '24 hours'
      WHERE status = 'PENDING_REFERENCE'
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        ADD CONSTRAINT chk_wagering_reference_retry_count
          CHECK (reference_retry_count >= 0)
    `);
        await queryRunner.query(`
      CREATE INDEX idx_wagering_reference_retry_due
      ON wagering_transactions (reference_next_retry_at, created_at)
      WHERE status = 'PENDING_REFERENCE'
    `);
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      DROP INDEX IF EXISTS idx_wagering_reference_retry_due
    `);
        await queryRunner.query(`
      ALTER TABLE wagering_transactions
        DROP CONSTRAINT IF EXISTS chk_wagering_reference_retry_count,
        DROP COLUMN IF EXISTS reference_expires_at,
        DROP COLUMN IF EXISTS reference_next_retry_at,
        DROP COLUMN IF EXISTS reference_retry_count
    `);
    }
}
