
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProcessedMessagePayloadHash1792195600000
  implements MigrationInterface
{
  name = 'AddProcessedMessagePayloadHash1792195600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE processed_messages
        ADD COLUMN payload_hash CHAR(64)
    `);

    await queryRunner.query(`
      ALTER TABLE processed_messages
        ADD CONSTRAINT chk_processed_messages_payload_hash
        CHECK (
          payload_hash IS NULL
          OR payload_hash ~ '^[a-f0-9]{64}$'
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE processed_messages
        DROP CONSTRAINT IF EXISTS chk_processed_messages_payload_hash
    `);

    await queryRunner.query(`
      ALTER TABLE processed_messages
        DROP COLUMN IF EXISTS payload_hash
    `);
  }
}
