import { Activity, Crosshair, Gavel, Inbox, Timer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ModerationHealth } from '@escambo/types';
import { QueryState } from '../../components/ui';
import { dtm, durationLabel, percentLabel } from '../../lib/format';
import { useModerationHealth } from '../../lib/hooks';

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
 * Saúde da moderação (ADR 47): o que espera agora, quanto a fila demora para decidir, quanto a
 * sinalização automática acerta (e qual sinal erra mais) e como terminam as contestações. É o que
 * diz se o detector precisa de ajuste e se a fila está dando conta.
 */
export function ModerationHealthSection() {
  const [days, setDays] = useState<Period>(30);
  const health = useModerationHealth(days);

  return (
    <section className="card wide" aria-labelledby="health-title" data-testid="moderation-health">
      <div className="card-head">
        <h3 id="health-title">
          <Activity size={16} /> Saúde da moderação
        </h3>
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
                      ? `mais antiga desde ${dtm(h.queue.oldestPendingAt)} · ${plural(h.queue.automaticPending, 'automática', 'automáticas')}`
                      : 'a fila está vazia'
                  }
                />
                <Kpi
                  icon={<Timer size={18} />}
                  label="Tempo até decidir"
                  value={durationLabel(h.decisions.medianHours)}
                  hint={
                    h.decisions.total > 0
                      ? `mediana · 90% em até ${durationLabel(h.decisions.p90Hours)} · ${plural(h.decisions.total, 'decisão', 'decisões')}`
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

              <p className="muted tiny">
                {removalsSentence(h)}
                {h.queue.accountReviewsOpen > 0 &&
                  ` ${plural(h.queue.accountReviewsOpen, 'conta', 'contas')} em revisão por reincidência.`}
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
