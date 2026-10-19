import { TrendingUp } from 'lucide-react';
import { useState } from 'react';
import type { EarningsGranularity, WalletEarnings } from '@escambo/types';
import { EmptyState, QueryState } from '../../components/ui';
import { brl } from '../../lib/format';
import { useWalletEarnings } from '../../lib/hooks';
import { timezoneLabel } from '../../lib/timezones';

const PRESETS: { key: EarningsGranularity; label: string }[] = [
  { key: 'day', label: '30 dias' },
  { key: 'week', label: '12 semanas' },
  { key: 'month', label: '12 meses' },
];
const UNIT: Record<EarningsGranularity, string> = { day: 'dia', week: 'semana', month: 'mês' };

/** "2026-09-14" → "14/09/2026". */
const brDay = (s: string): string => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** Rótulo curto da barra: "09/2026" (mês) ou "14/09" (dia, ou a segunda da semana). */
export const barLabel = (bucket: string): string =>
  bucket.length === 7
    ? `${bucket.slice(5)}/${bucket.slice(0, 4)}`
    : `${bucket.slice(8)}/${bucket.slice(5, 7)}`;

/** Rótulo da linha da tabela: o mês, o dia ou "semana de 14/09/2026". */
export function periodLabel(bucket: string, granularity: EarningsGranularity): string {
  if (granularity === 'month') return barLabel(bucket);
  return granularity === 'week' ? `semana de ${brDay(bucket)}` : brDay(bucket);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "+40 créditos" / "−5 créditos": créditos nunca aparecem como reais. */
const credits = (n: number): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${plural(Math.abs(n), 'crédito', 'créditos')}`;

/** O que o leitor de tela ouve no lugar das barras: período, total e o maior período. */
function chartSummary(e: WalletEarnings): string {
  const top = e.series.reduce((a, b) => (b.amount > a.amount ? b : a), e.series[0]!);
  return (
    `Ganhos por ${UNIT[e.granularity]} de ${brDay(e.from)} a ${brDay(e.to)}: ` +
    `total ${brl(e.totals.amount)}; maior em ${periodLabel(top.bucket, e.granularity)}, ` +
    `${brl(top.amount)}.`
  );
}

function Body({ e }: { e: WalletEarnings }) {
  if (!e.hasEarnings) {
    return (
      <EmptyState>
        Você ainda não recebeu por nenhum trabalho. Quando um cliente aprovar uma entrega sua (ou um
        marco) ou uma troca com torna for concluída, o valor aparece aqui, por período.
      </EmptyState>
    );
  }
  const max = Math.max(...e.series.map((b) => b.amount), 0.01);
  const showCredits = e.credits.total !== 0 || e.credits.contracts > 0;
  // Por dia são 30 barras: o rótulo vai em uma a cada cinco, para não encavalar.
  const labelEvery = e.granularity === 'day' ? 5 : 1;
  return (
    <>
      <div className="fin-kpis">
        <div className="fin-kpi">
          <span className="kpi-label">Ganhos no período</span>
          <strong data-testid="earnings-total">{brl(e.totals.amount)}</strong>
          <span className="muted tiny">liberados na carteira, já sem a taxa</span>
        </div>
        <div className="fin-kpi">
          <span className="kpi-label">Contratações pagas</span>
          <strong data-testid="earnings-paid">{e.totals.contracts}</strong>
          <span className="muted tiny">
            {e.totals.barters > 0
              ? `e ${plural(e.totals.barters, 'troca', 'trocas')} com torna`
              : 'com valor liberado no período'}
          </span>
        </div>
        <div className="fin-kpi">
          <span className="kpi-label">Ticket médio</span>
          <strong data-testid="earnings-average">
            {e.totals.averageTicket === null ? '—' : brl(e.totals.averageTicket)}
          </strong>
          <span className="muted tiny">por contratação ou troca paga</span>
        </div>
        {showCredits && (
          <div className="fin-kpi" data-testid="earnings-credits">
            <span className="kpi-label">Créditos (time-bank)</span>
            <strong>{credits(e.credits.total)}</strong>
            <span className="muted tiny">
              {plural(e.credits.contracts, 'contratação aceita', 'contratações aceitas')}; contam no
              aceite e as devoluções descontam
            </span>
          </div>
        )}
      </div>
      <p className="muted tiny" data-testid="earnings-period">
        {brDay(e.from)} a {brDay(e.to)} · por {UNIT[e.granularity]} · dias no horário de{' '}
        {timezoneLabel(e.timezone)}.
      </p>
      {e.totals.amount === 0 ? (
        <EmptyState>Nenhum ganho em reais nesse período.</EmptyState>
      ) : (
        <>
          <div className="fin-chart" role="img" aria-label={chartSummary(e)}>
            {e.series.map((b, i) => (
              <div
                className="fin-bar"
                key={b.bucket}
                title={`${periodLabel(b.bucket, e.granularity)}: ${brl(b.amount)}`}
              >
                <div
                  className="fin-bar-fill"
                  style={
                    b.amount > 0
                      ? { height: `${Math.max(2, (b.amount / max) * 100)}%` }
                      : { height: 0, minHeight: 0 }
                  }
                />
                {(i % labelEvery === 0 || i === e.series.length - 1) && (
                  <span className="fin-bar-label">{barLabel(b.bucket)}</span>
                )}
              </div>
            ))}
          </div>
          <details>
            <summary>Ver os valores em tabela</summary>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Ganhos por {UNIT[e.granularity]}</caption>
                <thead>
                  <tr>
                    <th scope="col">Período</th>
                    <th scope="col" className="right">
                      Ganhos
                    </th>
                    <th scope="col" className="right">
                      Contratações
                    </th>
                    <th scope="col" className="right">
                      Trocas
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {e.series.map((b) => (
                    <tr key={b.bucket}>
                      <th scope="row">{periodLabel(b.bucket, e.granularity)}</th>
                      <td className="num">{brl(b.amount)}</td>
                      <td className="num">{b.contracts}</td>
                      <td className="num">{b.barters}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </>
  );
}

/**
 * Ganhos do freelancer por período (RF-082): o que ficou disponível na carteira por trabalho feito
 * (liberações do escrow e tornas recebidas), em barras no estilo do financeiro do admin, com a
 * tabela como alternativa acessível. Quem nunca recebeu vê um vazio que explica de onde o ganho
 * vem; créditos aparecem à parte, sem somar com reais.
 */
export function EarningsSection() {
  const [granularity, setGranularity] = useState<EarningsGranularity>('month');
  const earnings = useWalletEarnings({ granularity });
  return (
    <section className="card" aria-labelledby="earnings-title" data-testid="earnings">
      <div className="card-head">
        <h3 id="earnings-title">
          <TrendingUp size={16} /> Meus ganhos
        </h3>
        {earnings.data?.hasEarnings && (
          <div className="tabs tabs-mini" role="tablist" aria-label="Período dos ganhos">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="tab"
                aria-selected={granularity === p.key}
                className={granularity === p.key ? 'active' : ''}
                onClick={() => setGranularity(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <QueryState
        isLoading={earnings.isLoading}
        error={earnings.error}
        data={earnings.data}
        onRetry={() => void earnings.refetch()}
      >
        {(e) => <Body e={e} />}
      </QueryState>
    </section>
  );
}
