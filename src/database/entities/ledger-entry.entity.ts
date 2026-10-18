import { Column, CreateDateColumn, Entity, PrimaryColumn, } from 'typeorm';
@Entity({ name: 'ledger_entries' })
export class LedgerEntryEntity {
    @PrimaryColumn('uuid')
    id!: string;
    @Column({ name: 'wallet_id', type: 'uuid' })
    walletId!: string;
    @Column({ name: 'transaction_id', type: 'uuid' })
    transactionId!: string;
    @Column({ name: 'entry_type', type: 'varchar', length: 10 })
    entryType!: 'CREDIT' | 'DEBIT';
    @Column({ type: 'numeric', precision: 20, scale: 2 })
    amount!: string;
    @Column({ type: 'char', length: 3 })
    currency!: string;
    @Column({
        name: 'balance_before',
        type: 'numeric',
        precision: 20,
        scale: 2,
    })
    balanceBefore!: string;
    @Column({
        name: 'balance_after',
        type: 'numeric',
        precision: 20,
        scale: 2,
    })
    balanceAfter!: string;
    @CreateDateColumn({
        name: 'created_at',
        type: 'timestamptz',
    })
    createdAt!: Date;
}
