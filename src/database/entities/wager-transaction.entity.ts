
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'wagering_transactions' })
@Index(
  'uq_wagering_provider_idempotency',
  ['providerId', 'idempotencyKey'],
  { unique: true },
)
@Index(
  'uq_wagering_provider_external_transaction',
  ['providerId', 'externalTransactionId'],
  { unique: true },
)

@Index(
  'idx_wagering_provider_reference',
  ['providerId', 'referenceExternalTransactionId'],
  { where: '"reference_external_transaction_id" IS NOT NULL' },
)

@Index(
  'uq_wagering_processed_reversal_reference',
  ['referenceTransactionId', 'kind'],
  {
    unique: true,
    where:
      `"status" = 'PROCESSED' ` +
      `AND "reference_transaction_id" IS NOT NULL ` +
      `AND "kind" IN ('REFUND', 'ROLLBACK')`,
  },
)

export class WagerTransactionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'player_id', type: 'varchar', length: 100 })
  playerId!: string;

  @Column({ name: 'provider_id', type: 'varchar', length: 100 })
  providerId!: string;

  @Column({
    name: 'external_transaction_id',
    type: 'varchar',
    length: 255,
  })
  externalTransactionId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Column({ name: 'round_id', type: 'varchar', length: 255 })
  roundId!: string;

  @Column({ name: 'game_id', type: 'varchar', length: 255 })
  gameId!: string;

  @Column({ type: 'varchar', length: 30 })
  kind!: 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @Column({ type: 'varchar', length: 30 })
  status!:
    | 'PENDING'
    | 'PENDING_REFERENCE'
    | 'PROCESSED'
    | 'REJECTED'
    | 'FAILED';

  @Column({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({
    name: 'reference_external_transaction_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Column({
    name: 'reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId!: string | null;

  @Column({
    name: 'failure_code',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  failureCode!: string | null;

  @Column({
    name: 'response_snapshot',
    type: 'jsonb',
    nullable: true,
  })
  responseSnapshot!: Record<string, unknown> | null;

  @Column({
    name: 'processed_at',
    type: 'timestamptz',
    nullable: true,
  })
  processedAt!: Date | null;

    @Column({
    name: 'reference_retry_count',
    type: 'integer',
    default: 0,
  })
  referenceRetryCount!: number;

  @Column({
    name: 'reference_next_retry_at',
    type: 'timestamptz',
    nullable: true,
  })
  referenceNextRetryAt!: Date | null;

  @Column({
    name: 'reference_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  referenceExpiresAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
  })
  updatedAt!: Date;
}
