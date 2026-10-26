import {
  Activity,
  Crosshair,
  Download,
  Gavel,
  Inbox,
  MailCheck,
  Timer,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { ModerationHealth } from '@escambo/types';
import { ColumnChart, LineChart, VizLegend, type VizTone } from '../../components/charts';
import { Button, onTablistKeyDown, QueryState, Stat, TableWrap } from '../../components/ui';
import { api } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { dtm, durationLabel, percentLabel } from '../../lib/format';
import { useModerationHealth } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { SectionHead } from './SectionHead';

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

/** Cor de cada resultado: o que teve ação (verde), o que só é contexto (cinza), o que espera (âmbar). */
const TONE = { action: 'green', dismissed: 'muted', pending: 'amber' } as const satisfies Record<
  string,
  VizTone
>;
type Tone = keyof typeof TONE;

interface Part {
  label: string;
  value: number;
  tone: Tone;
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
        className={`breakdown-bar${total === 0 ? ' is-empty' : ''}`}
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
      <VizLegend
        items={parts.map((p) => ({ label: p.label, tone: TONE[p.tone], value: p.value }))}
      />
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
 * Série por dia (ADR 50): decisões empilhadas (com ação em verde, dispensadas em cinza) e a
 * mediana do tempo até decidir contra a meta. Cada gráfico tem um resumo em texto para leitor de
 * tela, a legenda fica fora do desenho e a tabela logo abaixo traz os números de cada dia.
 */
function HistoryCharts({ h, busy }: { h: ModerationHealth; busy: boolean }) {
  const hist = h.history;
  if (hist.length < 2) return null;
  const first = dm(hist[0]!.day);
  const last = dm(hist[hist.length - 1]!.day);
  const totals = hist.map((d) => d.actioned + d.dismissed);
  const barMax = Math.max(...totals);
  const peakDay = hist[totals.indexOf(barMax)]!.day;
  const known = hist.map((d) => d.medianHours).filter((v): v is number => v !== null);
  const overMeta = known.filter((v) => v > h.slaHours).length;
  const hours = (v: number): string => `${Math.round(v * 10) / 10} h`;

  return (
    <div className="health-history" data-testid="health-history">
      <div className="viz-block">
        <div className="chart-head">
          <h4 className="viz-title">Decisões por dia</h4>
          <span className="muted tiny">
            {first} a {last}
          </span>
        </div>
        <ColumnChart
          data={hist.map((d) => ({
            key: d.day,
            axis: dm(d.day),
            label: `${dm(d.day)}${d.flagged > 0 ? ` · ${plural(d.flagged, 'sinalização automática', 'sinalizações automáticas')}` : ''}`,
            values: [d.actioned, d.dismissed],
          }))}
          series={[
            { label: 'Com ação', tone: 'green' },
            { label: 'Dispensadas', tone: 'muted' },
          ]}
          summary={`Decisões por dia, de ${first} a ${last}: ${h.decisions.total} no período${
            barMax > 0 ? `, pico de ${barMax} em ${dm(peakDay)}` : ''
          }.`}
          format={(v) => String(v)}
          integer
          busy={busy}
        />
      </div>

      <div className="viz-block">
        <div className="chart-head">
          <h4 className="viz-title">Tempo até decidir</h4>
          <span className="muted tiny">mediana do dia</span>
        </div>
        <LineChart
          points={hist.map((d) => d.medianHours)}
          axis={hist.map((d) => dm(d.day))}
          labels={hist.map((d) => `${dm(d.day)}: mediana`)}
          target={{ value: h.slaHours, label: `meta ${h.slaHours} h` }}
          summary={`Tempo até decidir por dia, mediana em horas, meta de ${h.slaHours} h: ${
            known.length > 0
              ? `${overMeta} de ${known.length} dias acima da meta.`
              : 'nenhuma decisão no período.'
          }`}
          format={durationLabel}
          tick={hours}
          busy={busy}
        />
        <VizLegend
          items={[
            { label: 'Mediana do dia', tone: 'line' },
            { label: 'Meta', tone: 'target', value: durationLabel(h.slaHours) },
          ]}
        />
      </div>

      <details className="health-table">
        <summary>Ver a série por dia em tabela</summary>
        <TableWrap label="Tabela da série por dia">
          <table className="table t-list">
            <caption className="sr-only">
              Moderação por dia: os mesmos números dos gráficos, em tabela.
            </caption>
            <thead>
              <tr>
                <th>Dia</th>
                <th className="right">Denúncias</th>
                <th className="right">Automáticas</th>
                <th className="right">Com ação</th>
                <th className="right">Dispensadas</th>
                <th className="right">Mediana</th>
              </tr>
            </thead>
            <tbody>
              {hist.map((d) => (
                <tr key={d.day}>
                  <td>{dm(d.day)}</td>
                  <td className="num" data-label="Denúncias">
                    {d.received}
                  </td>
                  <td className="num" data-label="Automáticas">
                    {d.flagged}
                  </td>
                  <td className="num" data-label="Com ação">
                    {d.actioned}
                  </td>
                  <td className="num" data-label="Dispensadas">
                    {d.dismissed}
                  </td>
                  <td className="num" data-label="Mediana">
                    {durationLabel(d.medianHours)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </details>
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
      <SectionHead
        icon={Activity}
        title="Saúde da moderação"
        titleId="health-title"
        subtitle="O que espera agora, quanto a fila demora para decidir e quanto a sinalização automática acerta."
      >
        <div
          className="tabs tabs-mini"
          role="tablist"
          onKeyDown={onTablistKeyDown}
          aria-label="Período"
        >
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
      </SectionHead>
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
                <Stat
                  Icon={Inbox}
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
                <Stat
                  Icon={Timer}
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
                <Stat
                  Icon={Crosshair}
                  label="Acerto da sinalização"
                  value={percentLabel(h.automatic.precision)}
                  tone="blue"
                  hint={
                    decided > 0
                      ? `${plural(h.automatic.actioned, 'removida', 'removidas')} de ${plural(decided, 'decidida', 'decididas')}`
                      : 'nenhuma sinalização decidida'
                  }
                />
                <Stat
                  Icon={Gavel}
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

              <HistoryCharts h={h} busy={health.isPlaceholderData} />

              {h.automatic.signals.length > 0 && (
                <div className="viz-block">
                  <h4 className="viz-title">Acerto por sinal</h4>
                  <TableWrap label="Tabela da saúde da moderação">
                    <table className="table t-list health-signals" data-testid="health-signals">
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
                            <td className="right" data-label="Sinalizadas">
                              {s.flagged}
                            </td>
                            <td className="right" data-label="Removidas">
                              {s.actioned}
                            </td>
                            <td className="right" data-label="Dispensadas">
                              {s.dismissed}
                            </td>
                            <td data-label="Acerto">
                              <span className="meter">
                                <span className="meter-bar" aria-hidden="true">
                                  <i
                                    style={{ width: `${Math.round((s.precision ?? 0) * 100)}%` }}
                                  />
                                </span>
                                {percentLabel(s.precision)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
              )}

              <ul className="adm-notes">
                <li>
                  <Trash2 size={16} aria-hidden="true" />
                  <p className="muted tiny">
                    {removalsSentence(h)}
                    {h.queue.accountReviewsOpen > 0 &&
                      ` ${plural(h.queue.accountReviewsOpen, 'conta', 'contas')} em revisão (reincidência ou desistências).`}
                  </p>
                </li>
                <li>
                  <MailCheck size={16} aria-hidden="true" />
                  <p className="muted tiny" data-testid="health-report">
                    {reportStatusLine(h.dailyReport)}
                  </p>
                </li>
              </ul>
            </>
          );
        }}
      </QueryState>
    </section>
  );
}
