import { Injectable, Logger, NotFoundException, Optional, } from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import { DataSource } from 'typeorm';
export interface ReconcileWalletOutput {
    walletId: string;
    storedBalance: {
        amount: string;
        currency: string;
    };
    calculatedBalance: {
        amount: string;
        currency: string;
    };
    difference: {
        amount: string;
        currency: string;
    };
    consistent: boolean;
    checkedEntries: number;
}
interface ReconciliationRow {
    walletId: string;
    currency: string;
    storedBalance: string;
    calculatedBalance: string;
    difference: string;
    checkedEntries: number;
    consistent: boolean;
}
@Injectable()
export class ReconcileWallet {
    private readonly logger = new Logger(ReconcileWallet.name);
    constructor(private readonly dataSource: DataSource, 
    @Optional()
    private readonly tracerService?: TracerService) { }
    private recordDiscrepancyMetric(): void {
        if (!this.tracerService) {
            return;
        }
        try {
            this.tracerService
                .counter('wallet_reconciliation_discrepancies_total', {
                description: 'Total de reconciliações que identificaram divergências de saldo.',
            })
                .increment();
        }
        catch {
        }
    }
    async execute(walletId: string): Promise<ReconcileWalletOutput> {
        const rows = await this.dataSource.query<ReconciliationRow[]>(`
        SELECT
          w.id AS "walletId",
          w.currency AS currency,
          w.balance::text AS "storedBalance",
          COALESCE(
            SUM(
              CASE
                WHEN le.entry_type = 'CREDIT' THEN le.amount
                WHEN le.entry_type = 'DEBIT' THEN -le.amount
                ELSE 0
              END
            ),
            0
          )::numeric(20, 2)::text AS "calculatedBalance",
          (
            w.balance - COALESCE(
              SUM(
                CASE
                  WHEN le.entry_type = 'CREDIT' THEN le.amount
                  WHEN le.entry_type = 'DEBIT' THEN -le.amount
                  ELSE 0
                END
              ),
              0
            )
          )::numeric(20, 2)::text AS difference,
          COUNT(le.id)::int AS "checkedEntries",
          (
            w.balance = COALESCE(
              SUM(
                CASE
                  WHEN le.entry_type = 'CREDIT' THEN le.amount
                  WHEN le.entry_type = 'DEBIT' THEN -le.amount
                  ELSE 0
                END
              ),
              0
            )
          ) AS consistent
        FROM wallets w
        LEFT JOIN ledger_entries le
          ON le.wallet_id = w.id
        WHERE w.id = $1
        GROUP BY w.id, w.currency, w.balance
      `, [walletId]);
        const row = rows[0];
        if (!row) {
            throw new NotFoundException({
                code: 'WALLET_NOT_FOUND',
                message: 'Carteira não encontrada.',
            });
        }
        if (!row.consistent) {
            this.recordDiscrepancyMetric();
            this.logger.warn(JSON.stringify({
                event: 'wallet_reconciliation_discrepancy',
                walletId: row.walletId,
                checkedEntries: row.checkedEntries,
                currency: row.currency,
            }));
        }
        return {
            walletId: row.walletId,
            storedBalance: {
                amount: row.storedBalance,
                currency: row.currency,
            },
            calculatedBalance: {
                amount: row.calculatedBalance,
                currency: row.currency,
            },
            difference: {
                amount: row.difference,
                currency: row.currency,
            },
            consistent: row.consistent,
            checkedEntries: row.checkedEntries,
        };
    }
}
