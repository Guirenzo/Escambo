import { Download, LineChart } from 'lucide-react';
import { useState } from 'react';
import type { FinanceBucket, FinanceGranularity } from '@escambo/types';
import { Button, EmptyState, QueryState } from '../../components/ui';
import { api } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { addDays, brl, dateInputValue } from '../../lib/format';
import { useAdminFinance } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

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

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);

/** Traduz o preset em período + granularidade (o "6 meses" é o padrão da API). */
function rangeOf(preset: Preset, from: string, to: string): Range {
  const today = dateInputValue(new Date());
  if (preset === '30d') {
    return { from: dateInputValue(addDays(new Date(), -29)), to: today, granularity: 'day' };
  }
  if (preset === '12m') {
    const d = new Date();
    d.setMonth(d.getMonth() - 11, 1);
    return { from: dateInputValue(d), to: today, granularity: 'month' };
  }
  if (preset === 'custom') {
    return { from, to, granularity: daysBetween(from, to) <= 62 ? 'day' : 'month' };
  }
  return { granularity: 'month' };
}

/** "2026-09" → "09/2026"; "2026-09-14" → "14/09". */
const bucketLabel = (b: string): string =>
  b.length === 7 ? `${b.slice(5)}/${b.slice(0, 4)}` : `${b.slice(8)}/${b.slice(5, 7)}`;
/** "2026-09-14" → "14/09/2026". */
const brDay = (s: string): string => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/**
 * Financeiro do admin: receita da plataforma derivada do ledger de R$ (taxas retidas, líquidas
 * de estornos), depósitos, saques, reembolsos e GMV por dia ou mês, com o ledger exportável.
 */
export function FinanceSection() {
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>('6m');
  const [from, setFrom] = useState(dateInputValue(addDays(new Date(), -29)));
  const [to, setTo] = useState(dateInputValue(new Date()));
  const [exporting, setExporting] = useState(false);
  const q = rangeOf(preset, from, to);
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
      <div className="card-head">
        <h3 id="finance-title">
          <LineChart size={16} /> Financeiro
        </h3>
        <div className="fin-controls">
          <div className="tabs tabs-mini" role="tablist" aria-label="Período do relatório">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="tab"
                aria-selected={preset === p.key}
                className={preset === p.key ? 'active' : ''}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
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
            onClick={() => void exportCsv()}
            disabled={exporting}
          >
            <Download size={14} /> {exporting ? 'Exportando…' : 'Exportar CSV'}
          </Button>
        </div>
      </div>

      <QueryState
        isLoading={report.isLoading}
        error={report.error}
        data={report.data}
        onRetry={() => void report.refetch()}
      >
        {(r) => {
          const max = Math.max(...r.series.map((b) => b.revenue), 0.01);
          return (
            <>
              <div className="fin-kpis">
                <div className="fin-kpi">
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
              <p className="muted tiny" data-testid="finance-period">
                {brDay(r.from)} a {brDay(r.to)} · por {r.granularity === 'day' ? 'dia' : 'mês'} ·
                agora: {brl(r.now.inEscrow)} em escrow e {brl(r.now.usersBalance)} de saldo dos
                usuários (passivo com usuários).
              </p>

              {r.series.length === 0 ? (
                <EmptyState>Sem movimentação no período.</EmptyState>
              ) : (
                <>
                  <div
                    className="fin-chart"
                    role="img"
                    aria-label={`Receita da plataforma por ${r.granularity === 'day' ? 'dia' : 'mês'}`}
                  >
                    {r.series.map((b: FinanceBucket) => (
                      <div
                        className="fin-bar"
                        key={b.bucket}
                        title={`${bucketLabel(b.bucket)}: ${brl(b.revenue)}`}
                      >
                        <div
                          className="fin-bar-fill"
                          style={{ height: `${Math.max(2, (b.revenue / max) * 100)}%` }}
                        />
                        <span className="fin-bar-label">{bucketLabel(b.bucket)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="table-wrap">
                    <table className="table">
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
                            <td>{bucketLabel(b.bucket)}</td>
                            <td className="num">{brl(b.revenue)}</td>
                            <td className="num">{brl(b.deposits)}</td>
                            <td className="num">{brl(b.withdrawals)}</td>
                            <td className="num">{brl(b.refunds)}</td>
                            <td className="num">{b.completedContracts}</td>
                            <td className="num">{brl(b.gmv)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          );
        }}
      </QueryState>
    </section>
  );
}
