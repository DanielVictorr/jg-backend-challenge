
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLedgerBalanceSnapshots1760650001000
  implements MigrationInterface
{
  name = 'AddLedgerBalanceSnapshots1760650001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_entries
        ADD COLUMN balance_before NUMERIC(20, 2) NOT NULL,
        ADD COLUMN balance_after NUMERIC(20, 2) NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE ledger_entries
        ADD CONSTRAINT chk_ledger_balance_before_non_negative
          CHECK (balance_before >= 0),
        ADD CONSTRAINT chk_ledger_balance_after_non_negative
          CHECK (balance_after >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_entries
        DROP CONSTRAINT chk_ledger_balance_after_non_negative,
        DROP CONSTRAINT chk_ledger_balance_before_non_negative,
        DROP COLUMN balance_after,
        DROP COLUMN balance_before
    `);
  }
}