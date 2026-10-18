import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddInboxReceivedAt1792195700000 implements MigrationInterface {
    name = 'AddInboxReceivedAt1792195700000';
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      ALTER TABLE processed_messages
        ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
        await queryRunner.query(`
      ALTER TABLE processed_messages
        ALTER COLUMN processed_at DROP DEFAULT,
        ALTER COLUMN processed_at DROP NOT NULL
    `);
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      UPDATE processed_messages
      SET processed_at = COALESCE(processed_at, received_at, NOW())
      WHERE processed_at IS NULL
    `);
        await queryRunner.query(`
      ALTER TABLE processed_messages
        ALTER COLUMN processed_at SET DEFAULT NOW(),
        ALTER COLUMN processed_at SET NOT NULL
    `);
        await queryRunner.query(`
      ALTER TABLE processed_messages
        DROP COLUMN received_at
    `);
    }
}
