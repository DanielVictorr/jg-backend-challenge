import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforceUniqueProcessedReversal1792195400000 implements MigrationInterface {
  name = 'EnforceUniqueProcessedReversal1792195400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates: Array<{
      reference_transaction_id: string;
      kind: string;
      total: string;
    }> = await queryRunner.query(`
      SELECT
        reference_transaction_id,
        kind,
        COUNT(*) AS total
      FROM wagering_transactions
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL
      GROUP BY reference_transaction_id, kind
      HAVING COUNT(*) > 1
  `);

    if (duplicates.length > 0) {
      throw new Error(
        'Cannot enforce unique processed reversals: ' +
          'duplicate reversals already exist.',
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_wagering_processed_reversal_reference
      ON wagering_transactions (
        reference_transaction_id,
        kind
      )
      WHERE status = 'PROCESSED'
        AND reference_transaction_id IS NOT NULL
        AND kind IN ('REFUND', 'ROLLBACK')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS uq_wagering_processed_reversal_reference
    `);
  }
}
