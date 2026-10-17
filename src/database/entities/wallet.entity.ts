
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'wallets' })
@Index('uq_wallets_player_currency', ['playerId', 'currency'], {
  unique: true,
})
export class WalletEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({
    name: 'player_id',
    type: 'varchar',
    length: 100,
  })
  playerId!: string;

  @Column({
    type: 'char',
    length: 3,
  })
  currency!: string;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: '0',
  })
  balance!: string;

  @Column({
    type: 'integer',
    default: 1,
  })
  version!: number;

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