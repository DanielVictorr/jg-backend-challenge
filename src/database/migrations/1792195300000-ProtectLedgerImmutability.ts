import { MigrationInterface, QueryRunner } from 'typeorm';
export class ProtectLedgerImmutability1792195300000 implements MigrationInterface {
    name = 'ProtectLedgerImmutability1792195300000';
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      ALTER TABLE ledger_entries
        ADD CONSTRAINT chk_ledger_balance_arithmetic
        CHECK (
          (
            entry_type = 'CREDIT'
            AND balance_after = balance_before + amount
          )
          OR
          (
            entry_type = 'DEBIT'
            AND balance_after = balance_before - amount
          )
        )
    `);
        await queryRunner.query(`
      CREATE FUNCTION prevent_ledger_entry_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION
          'Ledger entries are immutable: % operation is not allowed',
          TG_OP
          USING ERRCODE = '55000';
      END;
      $$
    `);
        await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_no_update_delete
      BEFORE UPDATE OR DELETE
      ON ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_entry_mutation()
    `);
        await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_no_truncate
      BEFORE TRUNCATE
      ON ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION prevent_ledger_entry_mutation()
    `);
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_ledger_entries_no_truncate
      ON ledger_entries
    `);
        await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_ledger_entries_no_update_delete
      ON ledger_entries
    `);
        await queryRunner.query(`
      DROP FUNCTION IF EXISTS prevent_ledger_entry_mutation()
    `);
        await queryRunner.query(`
      ALTER TABLE ledger_entries
        DROP CONSTRAINT IF EXISTS chk_ledger_balance_arithmetic
    `);
    }
}
