import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { TracerService } from '@nestjs/observe';
import { ProcessWagerTransaction, type InboxDuplicateResult, type ProcessWagerTransactionOutput, } from './process-wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
describe('ProcessWagerTransaction - métricas', () => {
    function createSubject() {
        const increment = vi.fn();
        const observe = vi.fn();
        const counter = vi.fn().mockReturnValue({ increment });
        const summary = vi.fn().mockReturnValue({ observe });
        const tracerService = {
            counter,
            summary,
        } as unknown as TracerService;
        const subject = new ProcessWagerTransaction({} as DataSource, tracerService);
        const recordMetrics = (outcome: ProcessWagerTransactionOutput | InboxDuplicateResult) => (subject as unknown as {
            recordMetrics: (value: ProcessWagerTransactionOutput | InboxDuplicateResult) => void;
        }).recordMetrics(outcome);
        const recordProcessingLatency = (durationMs: number) => (subject as unknown as {
            recordProcessingLatency: (durationMs: number) => void;
        }).recordProcessingLatency(durationMs);
        const recordLockConflict = () => (subject as unknown as {
            recordLockConflict: () => void;
        }).recordLockConflict();
        return {
            counter,
            increment,
            summary,
            observe,
            recordMetrics,
            recordProcessingLatency,
            recordLockConflict,
        };
    }
    function createOutcome(overrides: Partial<ProcessWagerTransactionOutput> = {}): ProcessWagerTransactionOutput {
        return {
            transactionId: 'transaction-test',
            walletId: 'wallet-test',
            status: WagerTransactionStatus.Processed,
            kind: 'CREDIT',
            balance: {
                amount: '100.00',
                currency: 'BRL',
            },
            idempotentReplay: false,
            ...overrides,
        };
    }
    it('registra a duração do processamento em milissegundos', () => {
        const { summary, observe, recordProcessingLatency } = createSubject();
        recordProcessingLatency(125);
        expect(summary).toHaveBeenCalledWith('wager_transaction_processing_duration_ms', expect.objectContaining({
            description: expect.any(String),
        }));
        expect(observe).toHaveBeenCalledWith(125);
    });
    it('ignora duração inválida', () => {
        const { summary, observe, recordProcessingLatency } = createSubject();
        recordProcessingLatency(Number.NaN);
        recordProcessingLatency(Number.POSITIVE_INFINITY);
        expect(summary).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
    });
    it('contabiliza conflitos de bloqueio', () => {
        const { counter, increment, recordLockConflict } = createSubject();
        recordLockConflict();
        expect(counter).toHaveBeenCalledWith('wager_lock_conflicts_total', expect.objectContaining({
            description: expect.any(String),
        }));
        expect(increment).toHaveBeenCalledTimes(1);
    });
    it('contabiliza uma nova transação pelo status', () => {
        const { counter, increment, recordMetrics } = createSubject();
        recordMetrics(createOutcome());
        expect(counter).toHaveBeenCalledWith('wager_transactions_total', expect.objectContaining({
            labels: ['status'],
        }));
        expect(increment).toHaveBeenCalledWith({
            status: WagerTransactionStatus.Processed,
        });
    });
    it('contabiliza replay idempotente sem contar nova transação', () => {
        const { counter, increment, recordMetrics } = createSubject();
        recordMetrics(createOutcome({ idempotentReplay: true }));
        expect(counter).toHaveBeenCalledTimes(1);
        expect(counter).toHaveBeenCalledWith('wager_idempotent_replays_total', expect.any(Object));
        expect(increment).toHaveBeenCalledWith();
    });
    it('contabiliza mensagem duplicada da Inbox separadamente', () => {
        const { counter, increment, recordMetrics } = createSubject();
        recordMetrics({ duplicateMessage: true });
        expect(counter).toHaveBeenCalledTimes(1);
        expect(counter).toHaveBeenCalledWith('wager_duplicate_messages_total', expect.any(Object));
        expect(increment).toHaveBeenCalledWith();
    });
    it('ignora status que não pertence ao enum do domínio', () => {
        const { counter, increment, recordMetrics } = createSubject();
        recordMetrics(createOutcome({ status: 'STATUS_INVALIDO' }));
        expect(counter).not.toHaveBeenCalled();
        expect(increment).not.toHaveBeenCalled();
    });
    it('não propaga falhas da telemetria', () => {
        const counter = vi.fn().mockImplementation(() => {
            throw new Error('Telemetria indisponível');
        });
        const tracerService = { counter } as unknown as TracerService;
        const subject = new ProcessWagerTransaction({} as DataSource, tracerService);
        const recordMetrics = (subject as unknown as {
            recordMetrics: (outcome: ProcessWagerTransactionOutput | InboxDuplicateResult) => void;
        }).recordMetrics.bind(subject);
        expect(() => recordMetrics(createOutcome())).not.toThrow();
    });
});
