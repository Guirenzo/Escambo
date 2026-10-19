import type { AdminFinanceReport, FinanceBucket, FinanceGranularity } from '@escambo/types';
import { csvDocument, ptDecimal } from '../../utils/csv';
import { financeRepository, type LedgerExportRow } from './finance.repository';
import { resolvePeriod } from './report-period';

export interface FinanceQuery {
  from?: string;
  to?: string;
  granularity: FinanceGranularity;
}

// Os períodos moram em report-period.ts (o relatório de uso usa os mesmos); estes nomes ficam
// exportados daqui também, onde sempre estiveram.
export { bounds, defaultRange, todayBrt } from './report-period';

const money = (v: number): number => Math.round(v * 100) / 100;
const empty = (bucket: string): FinanceBucket => ({
  bucket,
  revenue: 0,
  deposits: 0,
  withdrawals: 0,
  refunds: 0,
  completedContracts: 0,
  gmv: 0,
});

/** Valores em reais no CSV: duas casas e vírgula decimal. */
const ptNumber = (v: string | number): string => ptDecimal(v, 2);

export const financeService = {
  async report(q: FinanceQuery): Promise<AdminFinanceReport> {
    const { from, to, fromUtc, toUtc } = resolvePeriod(q);
    const [ledger, contracts, now] = await Promise.all([
      financeRepository.ledgerByBucket(fromUtc, toUtc, q.granularity),
      financeRepository.contractsByBucket(fromUtc, toUtc, q.granularity),
      financeRepository.snapshot(),
    ]);

    const byBucket = new Map<string, FinanceBucket>();
    for (const r of ledger) {
      const b = byBucket.get(r.bucket) ?? empty(r.bucket);
      b.revenue = money(Number(r.revenue));
      b.deposits = money(Number(r.deposits));
      b.withdrawals = money(Number(r.withdrawals));
      b.refunds = money(Number(r.refunds));
      byBucket.set(r.bucket, b);
    }
    for (const r of contracts) {
      const b = byBucket.get(r.bucket) ?? empty(r.bucket);
      b.completedContracts = Number(r.completed);
      b.gmv = money(Number(r.gmv));
      byBucket.set(r.bucket, b);
    }
    const series = [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    const totals = series.reduce(
      (acc, b) => ({
        revenue: money(acc.revenue + b.revenue),
        deposits: money(acc.deposits + b.deposits),
        withdrawals: money(acc.withdrawals + b.withdrawals),
        refunds: money(acc.refunds + b.refunds),
        completedContracts: acc.completedContracts + b.completedContracts,
        gmv: money(acc.gmv + b.gmv),
      }),
      { revenue: 0, deposits: 0, withdrawals: 0, refunds: 0, completedContracts: 0, gmv: 0 },
    );
    return { from, to, granularity: q.granularity, totals, series, now };
  },

  /** Ledger do período em CSV (ponto e vírgula, vírgula decimal, BOM: abre direto no Excel pt-BR). */
  async exportCsv(q: FinanceQuery): Promise<{ fileName: string; csv: string }> {
    const { from, to, fromUtc, toUtc } = resolvePeriod(q);
    const rows = await financeRepository.ledgerRows(fromUtc, toUtc);
    return { fileName: `escambo-ledger-${from}_${to}.csv`, csv: toCsv(rows) };
  },
};

export function toCsv(rows: LedgerExportRow[]): string {
  const header = [
    'id',
    'data_hora_utc',
    'usuario',
    'motivo',
    'valor_disponivel',
    'valor_retido',
    'disponivel_apos',
    'retido_apos',
    'contrato_id',
    'pagamento_id',
    'saque_id',
  ];
  const lines = rows.map((r) => [
    r.id,
    new Date(r.created_at).toISOString(),
    r.user_email,
    r.reason,
    ptNumber(r.amount),
    ptNumber(r.pending_delta),
    ptNumber(r.balance_after),
    ptNumber(r.pending_after),
    r.contract_id,
    r.payment_id,
    r.withdrawal_id,
  ]);
  return csvDocument(header, lines);
}
