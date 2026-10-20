import type {
  AdminUsageReport,
  FinanceGranularity,
  UsageBucket,
  UsageTotals,
} from '@escambo/types';
import { clock } from '../../utils/clock';
import { financeRepository } from './finance.repository';
import { bounds, bucketsIn, resolvePeriod } from './report-period';
import { usageRepository, type SnapshotRow, type SnapshotType } from './usage.repository';

export interface UsageQuery {
  from?: string;
  to?: string;
  granularity: FinanceGranularity;
}

/** O texto que a tela mostra: a definição de ativo tem de ser a mesma do SQL (usage.repository). */
export const ACTIVE_DEFINITION =
  'Ativo é quem entrou na conta ou renovou a sessão (o site renova sozinho enquanto é usado), ' +
  'mandou mensagem no chat ou mudou o status de uma contratação no período. Administradores e as ' +
  'mudanças automáticas da plataforma (aprovação tácita, proposta expirada, disputa aberta por ' +
  'prazo) não contam.';

/** Cada granularidade lê o snapshot do mesmo tamanho. */
export const SNAPSHOT_TYPE: Record<FinanceGranularity, SnapshotType> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};
const GRANULARITY: Record<SnapshotType, FinanceGranularity> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

const zero = (): UsageTotals => ({
  newUsers: 0,
  newContracts: 0,
  completedContracts: 0,
  cancelledContracts: 0,
  activeUsers: 0,
});
const money = (v: number): number => Math.round(v * 100) / 100;

const fromSnapshot = (s: SnapshotRow): UsageTotals => ({
  newUsers: Number(s.new_users),
  newContracts: Number(s.new_contracts),
  completedContracts: Number(s.completed_contracts),
  cancelledContracts: Number(s.cancelled_contracts),
  activeUsers: Number(s.active_users),
});

/** Números calculados agora, por balde (só os baldes com algum movimento aparecem). */
async function liveByBucket(
  from: Date,
  to: Date,
  granularity: FinanceGranularity,
): Promise<Map<string, UsageTotals>> {
  const [counts, active] = await Promise.all([
    usageRepository.countsByBucket(from, to, granularity),
    usageRepository.activeByBucket(from, to, granularity),
  ]);
  const out = new Map<string, UsageTotals>();
  for (const r of counts) {
    out.set(r.bucket, {
      ...zero(),
      newUsers: Number(r.new_users),
      newContracts: Number(r.new_contracts),
      completedContracts: Number(r.completed_contracts),
      cancelledContracts: Number(r.cancelled_contracts),
    });
  }
  for (const r of active) {
    out.set(r.bucket, { ...(out.get(r.bucket) ?? zero()), activeUsers: Number(r.active_users) });
  }
  return out;
}

export const usageService = {
  /**
   * Uso por dia, semana ou mês. Balde inteiro dentro do período e já fechado lê o snapshot gravado
   * pelo job (a fotografia do dia em que fechou, que não muda se dados de origem forem anonimizados
   * ou expurgados depois); o resto (hoje, a semana ou o mês corrente, as pontas cortadas pelo
   * período e o que ficou sem snapshot) é calculado agora. Ativos no total: pessoas distintas no
   * período inteiro, sempre calculado agora (não é a soma dos baldes).
   */
  async report(q: UsageQuery): Promise<AdminUsageReport> {
    const { from, to, fromUtc, toUtc } = resolvePeriod(q);
    const buckets = bucketsIn(from, to, q.granularity);
    const [snaps, activeTotal] = await Promise.all([
      usageRepository.snapshots(
        SNAPSHOT_TYPE[q.granularity],
        buckets[0]!.start,
        buckets[buckets.length - 1]!.start,
      ),
      usageRepository.activeTotal(fromUtc, toUtc),
    ]);
    const saved = new Map(snaps.map((s) => [s.period_start, s]));
    const missing = buckets.filter((b) => !(b.whole && saved.has(b.start)));

    let live = new Map<string, UsageTotals>();
    if (missing.length > 0) {
      // Um intervalo só, do primeiro ao último balde sem snapshot, cortado pelo período pedido.
      const first = missing[0]!.start < from ? from : missing[0]!.start;
      const last = missing[missing.length - 1]!.end > to ? to : missing[missing.length - 1]!.end;
      const range = bounds(first, last);
      live = await liveByBucket(range.fromUtc, range.toUtc, q.granularity);
    }

    const series: UsageBucket[] = buckets.map((b) => {
      const snap = b.whole ? saved.get(b.start) : undefined;
      return snap
        ? { bucket: b.key, source: 'snapshot', ...fromSnapshot(snap) }
        : { bucket: b.key, source: 'live', ...(live.get(b.key) ?? zero()) };
    });
    const totals = series.reduce<UsageTotals>(
      (acc, b) => ({
        newUsers: acc.newUsers + b.newUsers,
        newContracts: acc.newContracts + b.newContracts,
        completedContracts: acc.completedContracts + b.completedContracts,
        cancelledContracts: acc.cancelledContracts + b.cancelledContracts,
        activeUsers: acc.activeUsers,
      }),
      { ...zero(), activeUsers: activeTotal },
    );
    return {
      from,
      to,
      granularity: q.granularity,
      totals,
      series,
      activeDefinition: ACTIVE_DEFINITION,
    };
  },

  /**
   * Calcula e grava o snapshot de um período fechado (dia, semana de segunda a domingo ou mês, em
   * dias de Brasília): uso, a receita do ledger e o GMV, como o relatório os calcula. Diz se esta
   * chamada gravou (false: o período já tinha snapshot, e ele fica como estava).
   */
  async snapshot(type: SnapshotType, start: string, end: string): Promise<boolean> {
    const granularity = GRANULARITY[type];
    const key = granularity === 'month' ? start.slice(0, 7) : start;
    const { fromUtc, toUtc } = bounds(start, end);
    const [usage, ledger, cash, reviews] = await Promise.all([
      liveByBucket(fromUtc, toUtc, granularity),
      financeRepository.ledgerByBucket(fromUtc, toUtc, granularity),
      financeRepository.contractsByBucket(fromUtc, toUtc, granularity),
      usageRepository.reviews(fromUtc, toUtc),
    ]);
    const u = usage.get(key) ?? zero();
    const l = ledger.find((r) => r.bucket === key);
    const c = cash.find((r) => r.bucket === key);
    return usageRepository.insert({
      type,
      start,
      end,
      ...u,
      platformFees: money(Number(l?.revenue ?? 0)),
      totalRevenue: money(Number(c?.gmv ?? 0)),
      avgRating: money(reviews.avg),
      payload: {
        version: 1,
        deposits: money(Number(l?.deposits ?? 0)),
        withdrawals: money(Number(l?.withdrawals ?? 0)),
        refunds: money(Number(l?.refunds ?? 0)),
        completedCashContracts: Number(c?.completed ?? 0),
        reviews: reviews.count,
      },
      generatedAt: clock.now(),
    });
  },
};
