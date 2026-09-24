import type { AdminFinanceReport, FinanceBucket, FinanceGranularity } from '@escambo/types';
import { csvDocument, ptDecimal } from '../../utils/csv';
import { HttpError } from '../../utils/http-error';
import { financeRepository, type LedgerExportRow } from './finance.repository';

export interface FinanceQuery {
  from?: string;
  to?: string;
  granularity: FinanceGranularity;
}

const DAY_MS = 86_400_000;
/** Deslocamento fixo de Brasília (o país não tem horário de verão desde 2019). */
const BRT_OFFSET_HOURS = 3;
const MAX_DAYS = 400;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Hoje em Brasília, como AAAA-MM-DD. */
export function todayBrt(now: Date = new Date()): string {
  return isoDate(new Date(now.getTime() - BRT_OFFSET_HOURS * 3_600_000));
}

/** Limites do período: dias de Brasília → instantes UTC (`to` é exclusivo, começo do dia seguinte). */
export function bounds(from: string, to: string): { fromUtc: Date; toUtc: Date } {
  const fromUtc = new Date(`${from}T0${BRT_OFFSET_HOURS}:00:00Z`);
  const toUtc = new Date(new Date(`${to}T0${BRT_OFFSET_HOURS}:00:00Z`).getTime() + DAY_MS);
  return { fromUtc, toUtc };
}

/** Período padrão: últimos 30 dias (por dia) ou últimos 6 meses (por mês), até hoje. */
export function defaultRange(
  granularity: FinanceGranularity,
  now: Date = new Date(),
): {
  from: string;
  to: string;
} {
  const to = todayBrt(now);
  if (granularity === 'day')
    return { from: isoDate(new Date(new Date(to).getTime() - 29 * DAY_MS)), to };
  const [y, m] = to.split('-').map(Number);
  const start = new Date(Date.UTC(y!, m! - 1 - 5, 1));
  return { from: isoDate(start), to };
}

function resolve(q: FinanceQuery): { from: string; to: string; fromUtc: Date; toUtc: Date } {
  const def = defaultRange(q.granularity);
  const from = q.from ?? def.from;
  const to = q.to ?? def.to;
  const { fromUtc, toUtc } = bounds(from, to);
  if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime()) || fromUtc >= toUtc) {
    throw new HttpError(
      400,
      'Período inválido: a data inicial precisa ser até a final',
      'invalid_range',
    );
  }
  if ((toUtc.getTime() - fromUtc.getTime()) / DAY_MS > MAX_DAYS) {
    throw new HttpError(400, `Período máximo de ${MAX_DAYS} dias`, 'range_too_long');
  }
  return { from, to, fromUtc, toUtc };
}

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
    const { from, to, fromUtc, toUtc } = resolve(q);
    const format = q.granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
    const [ledger, contracts, now] = await Promise.all([
      financeRepository.ledgerByBucket(fromUtc, toUtc, format),
      financeRepository.contractsByBucket(fromUtc, toUtc, format),
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
    const { from, to, fromUtc, toUtc } = resolve(q);
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
