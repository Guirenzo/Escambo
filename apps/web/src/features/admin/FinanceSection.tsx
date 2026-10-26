import { CalendarRange, Coins, Download, LineChart } from 'lucide-react';
import { useState } from 'react';
import type { AdminFinanceReport, FinanceGranularity } from '@escambo/types';
import { ColumnChart } from '../../components/charts';
import { Button, EmptyState, onTablistKeyDown, QueryState, TableWrap } from '../../components/ui';
import { api } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { addDays, axisLabel, brl, brlAxis, dateInputValue } from '../../lib/format';
import { useAdminFinance } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { allBuckets, bucketFullLabel, GRANULARITY_WORD } from './buckets';
import { SectionHead } from './SectionHead';
import { UsageReport } from './UsageReport';

type Preset = '30d' | '6m' | '12m' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: '30d', label: 'Últimos 30 dias' },
  { key: '6m', label: '6 meses' },
  { key: '12m', label: '12 meses' },
  { key: 'custom', label: 'Período' },
];

interface Range {
  from?: string;
  to?: string;
  granularity: FinanceGranularity;
}

const GRANULARITIES: { key: FinanceGranularity; label: string }[] = [
  { key: 'day', label: 'Dia' },
  { key: 'week', label: 'Semana' },
  { key: 'month', label: 'Mês' },
];

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);

/**
 * Traduz o preset em período + granularidade. Sem escolha explícita (`chosen` null), cada preset
 * tem a sua: dia nos 30 dias, mês nos 6 e 12 meses, e no "Período" dia até 62 dias e mês acima.
 * O "6 meses" por mês é o padrão da API (vai sem datas); com outra granularidade, as datas vão.
 */
function rangeOf(
  preset: Preset,
  from: string,
  to: string,
  chosen: FinanceGranularity | null,
): Range {
  const today = dateInputValue(new Date());
  if (preset === '30d') {
    return {
      from: dateInputValue(addDays(new Date(), -29)),
      to: today,
      granularity: chosen ?? 'day',
    };
  }
  if (preset === '12m') {
    const d = new Date();
    d.setMonth(d.getMonth() - 11, 1);
    return { from: dateInputValue(d), to: today, granularity: chosen ?? 'month' };
  }
  if (preset === 'custom') {
    return { from, to, granularity: chosen ?? (daysBetween(from, to) <= 62 ? 'day' : 'month') };
  }
  if (chosen && chosen !== 'month') {
    const d = new Date();
    d.setMonth(d.getMonth() - 5, 1);
    return { from: dateInputValue(d), to: today, granularity: chosen };
  }
  return { granularity: 'month' };
}

/** "2026-09-14" → "14/09/2026". */
const brDay = (s: string): string => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** O que o leitor de tela ouve no lugar das colunas: período, total e o período de maior receita. */
export function revenueSummary(r: AdminFinanceReport): string {
  const head = `Receita da plataforma por ${GRANULARITY_WORD[r.granularity]}, de ${brDay(r.from)} a ${brDay(r.to)}: total ${brl(r.totals.revenue)}`;
  const top = r.series.reduce<AdminFinanceReport['series'][number] | null>(
    (a, b) => (!a || b.revenue > a.revenue ? b : a),
    null,
  );
  return top && top.revenue > 0
    ? `${head}; maior em ${bucketFullLabel(top.bucket, r.granularity)}, ${brl(top.revenue)}.`
    : `${head}.`;
}

/**
 * Financeiro do admin: receita da plataforma derivada do ledger de R$ (taxas retidas, líquidas
 * de estornos), depósitos, saques, reembolsos e GMV por dia, semana ou mês, com o ledger
 * exportável; embaixo, o uso da plataforma no mesmo período (RF-081).
 */
export function FinanceSection() {
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>('6m');
  const [from, setFrom] = useState(dateInputValue(addDays(new Date(), -29)));
  const [to, setTo] = useState(dateInputValue(new Date()));
  const [chosen, setChosen] = useState<FinanceGranularity | null>(null);
  const [exporting, setExporting] = useState(false);
  const q = rangeOf(preset, from, to, chosen);
  const report = useAdminFinance(q);

  /** Baixa com o token (a rota é autenticada) e dispara o download no navegador. */
  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const { blob, fileName } = await api.downloadFinanceCsv(q);
      saveBlob(blob, fileName);
      toast.success('CSV do ledger baixado.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível exportar');
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="card" aria-labelledby="finance-title" data-testid="finance">
      <SectionHead
        icon={LineChart}
        title="Financeiro"
        titleId="finance-title"
        subtitle="Receita da plataforma e o dinheiro que entrou e saiu no período, com o ledger em CSV."
      />
      <div className="fin-controls">
        <div
          className="tabs tabs-mini"
          role="tablist"
          onKeyDown={onTablistKeyDown}
          aria-label="Período do relatório"
        >
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={preset === p.key}
              className={preset === p.key ? 'active' : ''}
              onClick={() => {
                setPreset(p.key);
                setChosen(null);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="tabs tabs-mini" role="group" aria-label="Agrupar por">
          {GRANULARITIES.map((g) => (
            <button
              key={g.key}
              type="button"
              aria-pressed={q.granularity === g.key}
              className={q.granularity === g.key ? 'active' : ''}
              onClick={() => setChosen(g.key)}
            >
              {g.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="fin-range">
            <input
              type="date"
              aria-label="De"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="muted tiny">até</span>
            <input
              type="date"
              aria-label="Até"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          className="fin-export"
          onClick={() => void exportCsv()}
          disabled={exporting}
        >
          <Download size={14} /> {exporting ? 'Exportando…' : 'Exportar CSV'}
        </Button>
      </div>

      <QueryState
        isLoading={report.isLoading}
        error={report.error}
        data={report.data}
        onRetry={() => void report.refetch()}
      >
        {(r) => {
          const per = GRANULARITY_WORD[r.granularity];
          const byBucket = new Map(r.series.map((b) => [b.bucket, b]));
          const buckets = allBuckets(r.from, r.to, r.granularity);
          return (
            <>
              <div className="fin-kpis">
                <div className="fin-kpi lead">
                  <span className="kpi-label">Receita da plataforma</span>
                  <strong data-testid="finance-revenue">{brl(r.totals.revenue)}</strong>
                  <span className="muted tiny">taxas retidas, líquidas de estornos</span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">GMV concluído</span>
                  <strong>{brl(r.totals.gmv)}</strong>
                  <span className="muted tiny">
                    {r.totals.completedContracts} contratação(ões) concluída(s)
                  </span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">Depósitos</span>
                  <strong>{brl(r.totals.deposits)}</strong>
                  <span className="muted tiny">dinheiro que entrou</span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">Saques</span>
                  <strong>{brl(r.totals.withdrawals)}</strong>
                  <span className="muted tiny">dinheiro que saiu</span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">Reembolsos</span>
                  <strong>{brl(r.totals.refunds)}</strong>
                  <span className="muted tiny">devolvidos a clientes</span>
                </div>
              </div>
              <p className="viz-caption muted tiny" data-testid="finance-period">
                <CalendarRange size={14} aria-hidden="true" />
                {brDay(r.from)} a {brDay(r.to)} · por {per} · agora: {brl(r.now.inEscrow)} em escrow
                e {brl(r.now.usersBalance)} de saldo dos usuários (passivo com usuários).
              </p>

              {r.series.length === 0 ? (
                <EmptyState icon={Coins} title="Sem movimentação no período">
                  Nenhuma taxa, depósito, saque ou reembolso entre {brDay(r.from)} e {brDay(r.to)}.
                </EmptyState>
              ) : (
                <>
                  <div className="viz-block">
                    <h4 className="viz-title">Receita da plataforma por {per}</h4>
                    <ColumnChart
                      data={buckets.map((b, i) => ({
                        key: b,
                        axis: axisLabel(b, i === 0),
                        label: bucketFullLabel(b, r.granularity),
                        values: [byBucket.get(b)?.revenue ?? 0],
                      }))}
                      series={[{ label: 'Receita', tone: 'green' }]}
                      summary={revenueSummary(r)}
                      format={brl}
                      tick={brlAxis}
                      busy={report.isPlaceholderData}
                    />
                  </div>
                  <TableWrap label="Tabela do relatório financeiro">
                    <table className="table t-list">
                      <caption className="sr-only">
                        Relatório financeiro por {per}: os períodos com movimento.
                      </caption>
                      <thead>
                        <tr>
                          <th>Período</th>
                          <th className="right">Receita</th>
                          <th className="right">Depósitos</th>
                          <th className="right">Saques</th>
                          <th className="right">Reembolsos</th>
                          <th className="right">Concluídas</th>
                          <th className="right">GMV</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.series.map((b) => (
                          <tr key={b.bucket}>
                            <td>{bucketFullLabel(b.bucket, r.granularity)}</td>
                            <td className="num" data-label="Receita">
                              {brl(b.revenue)}
                            </td>
                            <td className="num" data-label="Depósitos">
                              {brl(b.deposits)}
                            </td>
                            <td className="num" data-label="Saques">
                              {brl(b.withdrawals)}
                            </td>
                            <td className="num" data-label="Reembolsos">
                              {brl(b.refunds)}
                            </td>
                            <td className="num" data-label="Concluídas">
                              {b.completedContracts}
                            </td>
                            <td className="num" data-label="GMV">
                              {brl(b.gmv)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </>
              )}
            </>
          );
        }}
      </QueryState>

      <UsageReport range={q} />
    </section>
  );
}
