import { Activity, Crosshair, Download, Gavel, Inbox, Timer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ModerationHealth } from '@escambo/types';
import { Button, QueryState } from '../../components/ui';
import { api } from '../../lib/api';
import { lineSegments, niceMax, scaleY, stackBar, xAt } from '../../lib/chart';
import { saveBlob } from '../../lib/download';
import { dtm, durationLabel, percentLabel } from '../../lib/format';
import { useModerationHealth } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/** Rótulos dos sinais do detector (ADR 45), como aparecem na tabela de acerto. */
const SIGNAL_LABEL: Record<string, string> = {
  pix: 'Pix',
  phone: 'Telefone',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  off_platform: 'Negociar por fora',
};

/** Rótulo do tipo removido, no singular e no plural. */
const REMOVAL_LABEL: Record<string, [string, string]> = {
  avatar: ['foto de perfil', 'fotos de perfil'],
  portfolio_item: ['imagem do portfólio', 'imagens do portfólio'],
  review: ['avaliação', 'avaliações'],
  message: ['mensagem', 'mensagens'],
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

type Tone = 'action' | 'dismissed' | 'pending';

interface Part {
  label: string;
  value: number;
  tone: Tone;
}

/** Tile de número-título, no mesmo desenho dos KPIs do painel. */
function Kpi({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint: ReactNode;
  tone?: 'amber' | 'blue';
}) {
  return (
    <div className={`kpi${tone ? ` ${tone}` : ''}`}>
      <div className="kpi-top">
        <span className="kpi-ico">{icon}</span>
        <span className="kpi-label">{label}</span>
      </div>
      <strong className="kpi-value">{value}</strong>
      <span className="muted tiny">{hint}</span>
    </div>
  );
}

/**
 * Parte-a-todo em uma barra empilhada: cada segmento com a cor do resultado, o número dentro e a
 * legenda embaixo, então a identidade nunca depende só da cor.
 */
function Breakdown({ title, parts }: { title: string; parts: Part[] }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const summary = parts.map((p) => `${p.label}: ${p.value}`).join(', ');
  return (
    <div className="breakdown">
      <div className="breakdown-head">
        <strong>{title}</strong>
        <span className="muted tiny">{total === 0 ? 'nada no período' : total}</span>
      </div>
      <div
        className={`breakdown-bar${total === 0 ? ' empty' : ''}`}
        role="img"
        aria-label={`${title}: ${summary}`}
      >
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.label}
              className={`seg ${p.tone}`}
              style={{ flexGrow: p.value }}
              title={`${p.label}: ${p.value}`}
            >
              {p.value}
            </span>
          ))}
      </div>
      <ul className="breakdown-legend">
        {parts.map((p) => (
          <li key={p.label}>
            <i className={`swatch ${p.tone}`} aria-hidden="true" />
            {p.label} <strong>{p.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function removalsSentence(h: ModerationHealth): string {
  if (h.removals.total === 0) return 'Nenhuma remoção no período.';
  const parts = h.removals.byType.map((t) => {
    const [one, many] = REMOVAL_LABEL[t.targetType] ?? [t.targetType, t.targetType];
    return plural(t.count, one, many);
  });
  return `${plural(h.removals.total, 'remoção', 'remoções')} no período: ${parts.join(', ')}.`;
}

/**
 * O que o relatório diário da meta (ADR 55) está fazendo, numa frase: onde está desligado (e
 * onde ligar), ou a que horas sai e o que a última conferência do dia decidiu e entregou.
 */
export function reportStatusLine(r: ModerationHealth['dailyReport']): string {
  if (r.mailProvider === 'off') {
    return 'Relatório diário da meta: sem e-mail na API (MAIL_PROVIDER=off); o painel continua destacando o estouro.';
  }
  if (!r.enabled) {
    return 'Relatório diário da meta: desligado nos parâmetros da plataforma.';
  }
  const head = `Relatório diário da meta: a partir das ${r.hour}h de Brasília, por e-mail aos admins, só quando estoura${
    r.mailProvider === 'simulated' ? ' (provedor simulado: fica na caixa de saída)' : ''
  }.`;
  const last = r.last;
  if (!last) return `${head} Ainda não conferiu.`;
  const when = `Última conferência ${dtm(last.at)}:`;
  if (!last.breached) return `${head} ${when} dentro da meta de ${last.slaHours} h.`;
  if (last.delivered > 0) {
    return `${head} ${when} meta de ${last.slaHours} h estourada, e-mail enviado a ${last.delivered} de ${plural(last.recipients, 'admin', 'admins')}.`;
  }
  if (last.recipients === 0) {
    return `${head} ${when} meta de ${last.slaHours} h estourada e nenhum admin no banco para avisar.`;
  }
  return `${head} ${when} meta de ${last.slaHours} h estourada e nenhum e-mail aceito pelo provedor (${plural(last.attempts, 'tentativa', 'tentativas')} de 3).`;
}

/** '2026-09-21' → '21/09', como os dias aparecem nos gráficos. */
const dm = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/**
 * Série por dia (ADR 50): decisões empilhadas e a mediana do tempo até decidir contra a meta.
 * SVG puro com a paleta de estado do painel; a identidade nunca é só cor (legenda, rótulos e
 * dica por dia), e cada gráfico tem um resumo em texto para leitor de tela.
 */
function HistoryCharts({ h }: { h: ModerationHealth }) {
  const hist = h.history;
  if (hist.length < 2) return null;
  const W = 320;
  const PLOT = 88; // o desenho vai de y=14 (rótulo do topo) à linha de base em y=102
  const first = dm(hist[0]!.day);
  const last = dm(hist[hist.length - 1]!.day);

  const totals = hist.map((d) => d.actioned + d.dismissed);
  const barMax = Math.max(...totals);
  const peakDay = hist[totals.indexOf(barMax)]!.day;
  const slot = W / hist.length;
  const barW = Math.max(1.5, slot * 0.7);

  const medians = hist.map((d) => d.medianHours);
  const known = medians.filter((v): v is number => v !== null);
  const lineMax = niceMax(Math.max(h.slaHours, ...known));
  const overMeta = known.filter((v) => v > h.slaHours).length;
  const metaY = 14 + PLOT - scaleY(h.slaHours, lineMax, PLOT);

  return (
    <div className="health-history" data-testid="health-history">
      <div className="chart-mini">
        <div className="chart-head">
          <strong>Decisões por dia</strong>
          <span className="muted tiny">
            {first} a {last}
          </span>
        </div>
        <svg
          viewBox="0 0 320 118"
          role="img"
          aria-label={`Decisões por dia, de ${first} a ${last}: ${h.decisions.total} no período${
            barMax > 0 ? `, pico de ${barMax} em ${dm(peakDay)}` : ''
          }.`}
        >
          {barMax > 0 && (
            <text x={0} y={10} fontSize={9} fill="var(--muted)">
              máx {barMax}
            </text>
          )}
          <line x1={0} y1={102.5} x2={W} y2={102.5} stroke="var(--border)" />
          {hist.map((d, i) => {
            if (d.actioned + d.dismissed === 0) return null;
            const x = i * slot + (slot - barW) / 2;
            const bar = stackBar(d.actioned, d.dismissed, barMax, PLOT, 102);
            return (
              <g key={d.day}>
                <title>{`${dm(d.day)}: ${d.actioned} com ação, ${d.dismissed} dispensadas${
                  d.flagged > 0 ? `, ${d.flagged} sinalizações automáticas` : ''
                }`}</title>
                {bar.up && (
                  <rect x={x} y={bar.up.y} width={barW} height={bar.up.h} fill="var(--green)" />
                )}
                {bar.down && (
                  <rect x={x} y={bar.down.y} width={barW} height={bar.down.h} fill="var(--muted)" />
                )}
              </g>
            );
          })}
          <text x={0} y={114} fontSize={9} fill="var(--muted)">
            {first}
          </text>
          <text x={W} y={114} textAnchor="end" fontSize={9} fill="var(--muted)">
            {last}
          </text>
        </svg>
        <ul className="breakdown-legend">
          <li>
            <i className="swatch action" aria-hidden="true" />
            Com ação <strong>{h.decisions.actioned}</strong>
          </li>
          <li>
            <i className="swatch dismissed" aria-hidden="true" />
            Dispensadas <strong>{h.decisions.dismissed}</strong>
          </li>
        </ul>
      </div>

      <div className="chart-mini">
        <div className="chart-head">
          <strong>Tempo até decidir</strong>
          <span className="muted tiny">mediana do dia</span>
        </div>
        <svg
          viewBox="0 0 320 118"
          role="img"
          aria-label={`Tempo até decidir por dia, mediana em horas, meta de ${h.slaHours} h: ${
            known.length > 0
              ? `${overMeta} de ${known.length} dias acima da meta.`
              : 'nenhuma decisão no período.'
          }`}
        >
          <text x={0} y={10} fontSize={9} fill="var(--muted)">
            {lineMax} h
          </text>
          <line x1={0} y1={102.5} x2={W} y2={102.5} stroke="var(--border)" />
          <line
            x1={0}
            y1={metaY}
            x2={W}
            y2={metaY}
            stroke="var(--amber)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <text x={W} y={metaY - 4} textAnchor="end" fontSize={9} fill="var(--amber-ink)">
            meta {h.slaHours} h
          </text>
          {lineSegments(medians, W, PLOT, lineMax).map((points) => (
            <polyline
              key={points}
              points={points}
              fill="none"
              stroke="var(--green-ink)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              transform="translate(0 14)"
            />
          ))}
          {hist.map((d, i) =>
            d.medianHours === null ? null : (
              <g key={d.day}>
                <title>{`${dm(d.day)}: mediana ${durationLabel(d.medianHours)}`}</title>
                <circle
                  cx={xAt(i, hist.length, W)}
                  cy={14 + PLOT - scaleY(d.medianHours, lineMax, PLOT)}
                  r={2.5}
                  fill="var(--green-ink)"
                />
              </g>
            ),
          )}
          <text x={0} y={114} fontSize={9} fill="var(--muted)">
            {first}
          </text>
          <text x={W} y={114} textAnchor="end" fontSize={9} fill="var(--muted)">
            {last}
          </text>
        </svg>
        <ul className="breakdown-legend">
          <li>
            <i className="swatch median" aria-hidden="true" />
            Mediana do dia
          </li>
          <li>
            <i className="swatch meta" aria-hidden="true" />
            Meta <strong>{durationLabel(h.slaHours)}</strong>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Saúde da moderação (ADR 47): o que espera agora, quanto a fila demora para decidir, quanto a
 * sinalização automática acerta (e qual sinal erra mais) e como terminam as contestações. É o que
 * diz se o detector precisa de ajuste e se a fila está dando conta.
 */
export function ModerationHealthSection() {
  const [days, setDays] = useState<Period>(30);
  const [exporting, setExporting] = useState(false);
  const health = useModerationHealth(days);
  const toast = useToast();

  /** A série do período em CSV (ADR 55), baixada com o token: a rota é autenticada. */
  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const { blob, fileName } = await api.downloadModerationCsv(days);
      saveBlob(blob, fileName);
      toast.success('CSV da moderação baixado.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível exportar');
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="card wide" aria-labelledby="health-title" data-testid="moderation-health">
      <div className="card-head">
        <h3 id="health-title">
          <Activity size={16} /> Saúde da moderação
        </h3>
        <div className="fin-controls">
          <div className="tabs tabs-mini" role="tablist" aria-label="Período">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={days === p}
                className={days === p ? 'active' : ''}
                onClick={() => setDays(p)}
              >
                {p} dias
              </button>
            ))}
          </div>
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
        isLoading={health.isLoading}
        error={health.error}
        data={health.data}
        onRetry={() => void health.refetch()}
      >
        {(h) => {
          const decided = h.automatic.actioned + h.automatic.dismissed;
          return (
            <>
              <div className="health-kpis">
                <Kpi
                  icon={<Inbox size={18} />}
                  label="Esperando decisão"
                  value={h.queue.pending}
                  tone={h.queue.pending > 0 ? 'amber' : undefined}
                  hint={
                    h.queue.oldestPendingAt
                      ? `mais antiga desde ${dtm(h.queue.oldestPendingAt)} · ${plural(h.queue.automaticPending, 'automática', 'automáticas')}${
                          h.queue.overSlaPending > 0
                            ? ` · ${h.queue.overSlaPending} ${h.queue.overSlaPending === 1 ? 'passou' : 'passaram'} da meta`
                            : ''
                        }`
                      : 'a fila está vazia'
                  }
                />
                <Kpi
                  icon={<Timer size={18} />}
                  label="Tempo até decidir"
                  value={durationLabel(h.decisions.medianHours)}
                  tone={
                    h.decisions.medianHours !== null && h.decisions.medianHours > h.slaHours
                      ? 'amber'
                      : undefined
                  }
                  hint={
                    h.decisions.total > 0
                      ? `mediana · meta ${durationLabel(h.slaHours)} · 90% em até ${durationLabel(h.decisions.p90Hours)} · ${plural(h.decisions.total, 'decisão', 'decisões')}`
                      : 'nenhuma decisão no período'
                  }
                />
                <Kpi
                  icon={<Crosshair size={18} />}
                  label="Acerto da sinalização"
                  value={percentLabel(h.automatic.precision)}
                  tone="blue"
                  hint={
                    decided > 0
                      ? `${plural(h.automatic.actioned, 'removida', 'removidas')} de ${plural(decided, 'decidida', 'decididas')}`
                      : 'nenhuma sinalização decidida'
                  }
                />
                <Kpi
                  icon={<Gavel size={18} />}
                  label="Contestações esperando"
                  value={h.queue.appealsPending}
                  tone={h.queue.appealsPending > 0 ? 'amber' : undefined}
                  hint={
                    h.appeals.decided > 0
                      ? `${percentLabel(h.appeals.overturnRate)} revertidas de ${plural(h.appeals.decided, 'decidida', 'decididas')} · ${durationLabel(h.appeals.medianHours)} até decidir`
                      : 'nenhuma decidida no período'
                  }
                />
              </div>

              <div className="health-bars">
                <Breakdown
                  title="Decisões da fila"
                  parts={[
                    { label: 'Com ação', value: h.decisions.actioned, tone: 'action' },
                    { label: 'Dispensadas', value: h.decisions.dismissed, tone: 'dismissed' },
                  ]}
                />
                <Breakdown
                  title="Sinalizações automáticas"
                  parts={[
                    { label: 'Removidas', value: h.automatic.actioned, tone: 'action' },
                    { label: 'Dispensadas', value: h.automatic.dismissed, tone: 'dismissed' },
                    { label: 'Pendentes', value: h.automatic.pending, tone: 'pending' },
                  ]}
                />
                <Breakdown
                  title="Contestações decididas"
                  parts={[
                    { label: 'Revertidas', value: h.appeals.overturned, tone: 'action' },
                    { label: 'Mantidas', value: h.appeals.upheld, tone: 'dismissed' },
                  ]}
                />
              </div>

              <HistoryCharts h={h} />

              <p className="muted tiny">
                {removalsSentence(h)}
                {h.queue.accountReviewsOpen > 0 &&
                  ` ${plural(h.queue.accountReviewsOpen, 'conta', 'contas')} em revisão por reincidência.`}
              </p>
              <p className="muted tiny" data-testid="health-report">
                {reportStatusLine(h.dailyReport)}
              </p>

              {h.automatic.signals.length > 0 && (
                <div className="table-wrap">
                  <table className="table health-signals" data-testid="health-signals">
                    <caption className="sr-only">
                      Acerto da sinalização automática por sinal
                    </caption>
                    <thead>
                      <tr>
                        <th>Sinal</th>
                        <th className="right">Sinalizadas</th>
                        <th className="right">Removidas</th>
                        <th className="right">Dispensadas</th>
                        <th>Acerto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.automatic.signals.map((s) => (
                        <tr key={s.signal}>
                          <td>{SIGNAL_LABEL[s.signal] ?? s.signal}</td>
                          <td className="right">{s.flagged}</td>
                          <td className="right">{s.actioned}</td>
                          <td className="right">{s.dismissed}</td>
                          <td>
                            <span className="meter">
                              <span className="meter-bar" aria-hidden="true">
                                <i style={{ width: `${Math.round((s.precision ?? 0) * 100)}%` }} />
                              </span>
                              {percentLabel(s.precision)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </QueryState>
    </section>
  );
}
