import type {
  ModerationHealth,
  ModerationHealthDay,
  OffPlatformSignal,
  RemovalTarget,
} from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { env } from '../../config/env';
import { parseSignals } from '../messaging/off-platform';
import { settingsRepository } from '../settings/settings.repository';
import { settingsService } from '../settings/settings.service';
import { DAY_MS, dayKey, startOfTodayBrt } from './moderation.day';
import { parseState, REPORT_STATE_KEY } from './moderation.sla-state';

export { dayKey };

/**
 * Saúde da moderação (ADR 47): o que está na fila agora e, num período, quanto tempo a fila leva
 * para decidir, quanto a sinalização automática acerta (por sinal) e como terminam as
 * contestações. Só leitura, sem tabela nova: tudo sai das denúncias e das remoções que já existem.
 * As contagens são exatas (agregadas no banco); só mediana e percentil saem de uma amostra.
 * A série por dia (ADR 50) conta no dia de Brasília e vem com a meta moderation_sla_hours.
 */

/** Amostra das durações mais recentes do período: sobra para a mediana sem carregar a tabela. */
const SAMPLE_LIMIT = 5000;

/** As datas são UTC no banco; o dia da série é o de Brasília, como no relatório financeiro. */
const DAY_BRT = (col: string): string =>
  `DATE_FORMAT(CONVERT_TZ(${col}, '+00:00', '-03:00'), '%Y-%m-%d')`;

/** Quantil por posição, com interpolação linear; null sem valores. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export const median = (values: number[]): number | null => quantile(values, 0.5);

/** Fração de `part` em `whole`, com três casas; null quando não há o que dividir. */
export const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;

/** Segundos → horas com uma casa. */
export const asHours = (seconds: number): number => Math.round((seconds / 3600) * 10) / 10;

/** Dias de Brasília entre dois instantes, contínuos e inclusive nas pontas (teto folgado de 400). */
export function listDays(since: Date, until: Date): string[] {
  const out: string[] = [];
  const end = dayKey(until);
  for (let t = since.getTime(); out.length < 400; t += DAY_MS) {
    const key = dayKey(new Date(t));
    if (out[out.length - 1] !== key) out.push(key);
    if (key === end) break;
  }
  return out;
}

/** Linhas por dia das consultas da série (o driver pode devolver contagens como string). */
export interface HistoryRows {
  decisions: { d: string; status: string; n: number }[];
  /** Denúncias criadas no dia (n) e, dentre elas, as automáticas (flagged). */
  byDay: { d: string; n: number; flagged: number }[];
  seconds: { d: string; secs: number }[];
}

/** Série contínua: dia sem nada vale zero, e a mediana do dia sai das durações daquele dia. */
export function buildHistory(days: string[], rows: HistoryRows): ModerationHealthDay[] {
  const secsByDay = new Map<string, number[]>();
  for (const r of rows.seconds) {
    const list = secsByDay.get(r.d) ?? [];
    list.push(Number(r.secs));
    secsByDay.set(r.d, list);
  }
  return days.map((day) => {
    const count = (status: string): number =>
      rows.decisions
        .filter((r) => r.d === day && r.status === status)
        .reduce((sum, r) => sum + Number(r.n), 0);
    const m = median(secsByDay.get(day) ?? []);
    const mine = rows.byDay.filter((r) => r.d === day);
    return {
      day,
      received: mine.reduce((sum, r) => sum + Number(r.n), 0),
      actioned: count('actioned'),
      dismissed: count('dismissed'),
      flagged: mine.reduce((sum, r) => sum + Number(r.flagged), 0),
      medianHours: m === null ? null : asHours(m),
    };
  });
}

/** Uma linha do GROUP BY status × sinais: quantas sinalizações terminaram assim. */
export interface AutomaticRow {
  status: string;
  off_platform: string | null;
  n: number;
}

/**
 * Sinalizações automáticas do período, por resultado e por sinal: removida conta como acerto do
 * detector, dispensada como erro, e o acerto é removidas sobre decididas.
 */
export function tallyAutomatic(rows: AutomaticRow[]): ModerationHealth['automatic'] {
  let flagged = 0;
  let pending = 0;
  let dismissed = 0;
  let actioned = 0;
  const per = new Map<
    OffPlatformSignal,
    { flagged: number; actioned: number; dismissed: number }
  >();
  for (const r of rows) {
    const n = Number(r.n);
    const outcome =
      r.status === 'dismissed' ? 'dismissed' : r.status === 'actioned' ? 'actioned' : 'pending';
    flagged += n;
    if (outcome === 'pending') pending += n;
    else if (outcome === 'dismissed') dismissed += n;
    else actioned += n;
    for (const signal of parseSignals(r.off_platform)) {
      const t = per.get(signal) ?? { flagged: 0, actioned: 0, dismissed: 0 };
      t.flagged += n;
      if (outcome === 'actioned') t.actioned += n;
      if (outcome === 'dismissed') t.dismissed += n;
      per.set(signal, t);
    }
  }
  const signals = [...per]
    .map(([signal, t]) => ({
      signal,
      ...t,
      precision: ratio(t.actioned, t.actioned + t.dismissed),
    }))
    .sort((a, b) => b.flagged - a.flagged || a.signal.localeCompare(b.signal));
  return {
    flagged,
    pending,
    dismissed,
    actioned,
    precision: ratio(actioned, actioned + dismissed),
    signals,
  };
}

interface AppealQueueRow extends RowDataPacket {
  pending: number;
  oldest: Date | null;
}
interface StatusCountRow extends RowDataPacket {
  status: string;
  n: number;
}
interface SecondsRow extends RowDataPacket {
  secs: number;
}
interface DayStatusCountRow extends StatusCountRow {
  d: string;
}
interface DaySecondsRow extends SecondsRow {
  d: string;
}
interface DayReceivedRow extends RowDataPacket {
  d: string;
  n: number;
  flagged: number;
}
interface RemovalTypeRow extends RowDataPacket {
  target_type: RemovalTarget;
  n: number;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const countOf = (rows: StatusCountRow[], status: string): number =>
  rows.filter((r) => r.status === status).reduce((sum, r) => sum + Number(r.n), 0);
const hoursOf = (rows: SecondsRow[], q: number): number | null => {
  const value = quantile(
    rows.map((r) => Number(r.secs)),
    q,
  );
  return value === null ? null : asHours(value);
};

type Window = { since: Date; until: Date };

/** Decisões da fila por dia e resultado, no dia de Brasília da decisão. */
const decisionsByDay = async (window: Window): Promise<DayStatusCountRow[]> =>
  (
    await pool.query<DayStatusCountRow[]>(
      `SELECT ${DAY_BRT('reviewed_at')} AS d, status, COUNT(*) AS n FROM content_reports
        WHERE status IN ('actioned', 'dismissed') AND reviewed_at >= :since
          AND reviewed_at < :until
        GROUP BY d, status`,
      window,
    )
  )[0];

/** Durações até decidir, as mais recentes do período (amostra da mediana), com o dia. */
const decisionSeconds = async (window: Window): Promise<DaySecondsRow[]> =>
  (
    await pool.query<DaySecondsRow[]>(
      `SELECT ${DAY_BRT('reviewed_at')} AS d, TIMESTAMPDIFF(SECOND, created_at, reviewed_at) AS secs
         FROM content_reports
        WHERE status IN ('actioned', 'dismissed') AND reviewed_at >= :since
          AND reviewed_at < :until
        ORDER BY reviewed_at DESC
        LIMIT ${SAMPLE_LIMIT}`,
      window,
    )
  )[0];

/** Denúncias criadas por dia, com quantas foram automáticas: uma consulta para as duas contagens. */
const reportsByDay = async (window: Window): Promise<DayReceivedRow[]> =>
  (
    await pool.query<DayReceivedRow[]>(
      `SELECT ${DAY_BRT('created_at')} AS d, COUNT(*) AS n,
              COALESCE(SUM(reporter_id IS NULL), 0) AS flagged
         FROM content_reports
        WHERE created_at >= :since AND created_at < :until
        GROUP BY d`,
      window,
    )
  )[0];

/** A fila agora, com o que já passou da meta (ADR 55). */
export interface QueueSnapshot {
  /** Denúncias pendentes ou em análise, contando cada uma (inclusive revisões de conta). */
  pending: number;
  oldest: Date | null;
  automatic: number;
  /** Contas em revisão por reincidência (ADR 41): ficam abertas de propósito, sem meta. */
  reviews: number;
  /** A denúncia de conteúdo mais antiga esperando (fora as revisões). */
  oldestContent: Date | null;
  /** Denúncias de conteúdo esperando há mais que a meta. */
  overSla: number;
  /** Quantos itens da fila do admin (alvo + imagem) essas denúncias representam. */
  overSlaItems: number;
}

interface QueueSnapshotRow extends RowDataPacket {
  pending: number;
  oldest: Date | null;
  automatic: number;
  reviews: number;
  oldest_content: Date | null;
  over_sla: number;
  over_sla_items: number;
}

/**
 * Uma consulta para o painel e para o relatório diário. Revisões de conta por reincidência são
 * contadas à parte e não entram na meta: elas ficam abertas enquanto a revisão durar.
 */
export async function openQueue(now: Date, slaHours: number): Promise<QueueSnapshot> {
  const threshold = new Date(now.getTime() - slaHours * 3_600_000);
  const [rows] = await pool.query<QueueSnapshotRow[]>(
    `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest,
            COALESCE(SUM(reporter_id IS NULL), 0) AS automatic,
            COALESCE(SUM(is_review), 0) AS reviews,
            MIN(CASE WHEN NOT is_review THEN created_at END) AS oldest_content,
            COALESCE(SUM(NOT is_review AND created_at < :threshold), 0) AS over_sla,
            COUNT(DISTINCT CASE WHEN NOT is_review AND created_at < :threshold
                                THEN CONCAT(target_type, ':', target_id, ':', COALESCE(image_url, '')) END) AS over_sla_items
       FROM (SELECT created_at, reporter_id, target_type, target_id, image_url,
                    (target_type = 'user' AND COALESCE(description, '') LIKE 'Reincidência:%') AS is_review
               FROM content_reports WHERE status IN ('pending', 'reviewing')) r`,
    { threshold },
  );
  const q = rows[0];
  return {
    pending: Number(q?.pending ?? 0),
    oldest: q?.oldest ?? null,
    automatic: Number(q?.automatic ?? 0),
    reviews: Number(q?.reviews ?? 0),
    oldestContent: q?.oldest_content ?? null,
    overSla: Number(q?.over_sla ?? 0),
    overSlaItems: Number(q?.over_sla_items ?? 0),
  };
}

export interface HistorySeries {
  history: ModerationHealthDay[];
  slaHours: number;
}

export const moderationHealthService = {
  /**
   * A série por dia em dias inteiros de Brasília: os últimos `days` dias mais hoje (parcial).
   * São as mesmas datas da aba do painel, só que o primeiro dia vem inteiro — é o que o CSV e o
   * relatório diário precisam (ADR 55). O painel continua com a janela de `report()`, cuja soma
   * bate com os totais do período por construção (ADR 50).
   */
  async history(days: number, now: Date = new Date()): Promise<HistorySeries> {
    const since = new Date(startOfTodayBrt(now).getTime() - days * DAY_MS);
    const window = { since, until: now };
    const [decisions, seconds, byDay, slaHours] = await Promise.all([
      decisionsByDay(window),
      decisionSeconds(window),
      reportsByDay(window),
      settingsService.number('moderation_sla_hours'),
    ]);
    return { history: buildHistory(listDays(since, now), { decisions, byDay, seconds }), slaHours };
  },

  async report(days: number, now: Date = new Date()): Promise<ModerationHealth> {
    const since = new Date(now.getTime() - days * DAY_MS);
    // O período fecha no mesmo `now` da série: o que for gravado durante a consulta fica para a
    // próxima, e a soma da série bate com o total por construção.
    const window = { since, until: now };
    const slaHours = await settingsService.number('moderation_sla_hours');
    const [
      queue,
      [appealQueue],
      decisionCounts,
      decisionSecs,
      [automatic],
      byDay,
      [appealCounts],
      [appealSecs],
      [removals],
      reportEnabled,
      reportRaw,
    ] = await Promise.all([
      openQueue(now, slaHours),
      pool.query<AppealQueueRow[]>(
        `SELECT COUNT(*) AS pending, MIN(appealed_at) AS oldest
           FROM content_removals WHERE status = 'appealed'`,
      ),
      decisionsByDay(window),
      decisionSeconds(window),
      pool.query<(AutomaticRow & RowDataPacket)[]>(
        `SELECT r.status, m.off_platform, COUNT(*) AS n
           FROM content_reports r
           LEFT JOIN messages m ON r.target_type = 'message' AND m.id = r.target_id
          WHERE r.reporter_id IS NULL AND r.created_at >= :since AND r.created_at < :until
          GROUP BY r.status, m.off_platform`,
        window,
      ),
      reportsByDay(window),
      pool.query<StatusCountRow[]>(
        `SELECT status, COUNT(*) AS n FROM content_removals
          WHERE status IN ('upheld', 'overturned') AND appealed_at IS NOT NULL
            AND decided_at >= :since AND decided_at < :until
          GROUP BY status`,
        window,
      ),
      pool.query<SecondsRow[]>(
        `SELECT TIMESTAMPDIFF(SECOND, appealed_at, decided_at) AS secs
           FROM content_removals
          WHERE status IN ('upheld', 'overturned') AND appealed_at IS NOT NULL
            AND decided_at >= :since AND decided_at < :until
          ORDER BY decided_at DESC
          LIMIT ${SAMPLE_LIMIT}`,
        window,
      ),
      pool.query<RemovalTypeRow[]>(
        `SELECT target_type, COUNT(*) AS n FROM content_removals
          WHERE removed_at >= :since AND removed_at < :until
          GROUP BY target_type ORDER BY n DESC`,
        window,
      ),
      settingsService.flag('moderation_sla_report_enabled'),
      settingsRepository.get(REPORT_STATE_KEY),
    ]);
    const aq = appealQueue[0];
    const dismissed = countOf(decisionCounts, 'dismissed');
    const actioned = countOf(decisionCounts, 'actioned');
    const upheld = countOf(appealCounts, 'upheld');
    const overturned = countOf(appealCounts, 'overturned');
    const byType = removals.map((r) => ({ targetType: r.target_type, count: Number(r.n) }));
    return {
      windowDays: days,
      queue: {
        pending: queue.pending,
        oldestPendingAt: iso(queue.oldest),
        automaticPending: queue.automatic,
        accountReviewsOpen: queue.reviews,
        appealsPending: Number(aq?.pending ?? 0),
        oldestAppealAt: iso(aq?.oldest),
        overSlaPending: queue.overSla,
      },
      decisions: {
        total: dismissed + actioned,
        dismissed,
        actioned,
        medianHours: hoursOf(decisionSecs, 0.5),
        p90Hours: hoursOf(decisionSecs, 0.9),
      },
      automatic: tallyAutomatic(automatic),
      appeals: {
        decided: upheld + overturned,
        upheld,
        overturned,
        medianHours: hoursOf(appealSecs, 0.5),
        overturnRate: ratio(overturned, upheld + overturned),
      },
      removals: { total: byType.reduce((sum, t) => sum + t.count, 0), byType },
      slaHours,
      history: buildHistory(listDays(since, now), {
        decisions: decisionCounts,
        byDay,
        seconds: decisionSecs,
      }),
      dailyReport: {
        enabled: reportEnabled,
        hour: env.DIGEST_HOUR,
        mailProvider: env.MAIL_PROVIDER,
        last: parseState(reportRaw),
      },
    };
  },
};
