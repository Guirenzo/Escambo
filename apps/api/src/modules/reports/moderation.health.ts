import type {
  ModerationHealth,
  ModerationHealthDay,
  OffPlatformSignal,
  RemovalTarget,
} from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { DEFAULT_TIMEZONE, localParts } from '../../utils/timezone';
import { parseSignals } from '../messaging/off-platform';
import { settingsService } from '../settings/settings.service';

/**
 * Saúde da moderação (ADR 47): o que está na fila agora e, num período, quanto tempo a fila leva
 * para decidir, quanto a sinalização automática acerta (por sinal) e como terminam as
 * contestações. Só leitura, sem tabela nova: tudo sai das denúncias e das remoções que já existem.
 * As contagens são exatas (agregadas no banco); só mediana e percentil saem de uma amostra.
 * A série por dia (ADR 50) conta no dia de Brasília e vem com a meta moderation_sla_hours.
 */

const DAY_MS = 86_400_000;
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

/** Dia ('AAAA-MM-DD') de um instante em Brasília, o mesmo fuso fixo do DAY_BRT. */
export function dayKey(at: Date): string {
  const p = localParts(DEFAULT_TIMEZONE, at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

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
  flagged: { d: string; n: number }[];
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
    return {
      day,
      actioned: count('actioned'),
      dismissed: count('dismissed'),
      flagged: rows.flagged.filter((r) => r.d === day).reduce((sum, r) => sum + Number(r.n), 0),
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

interface QueueRow extends RowDataPacket {
  pending: number;
  oldest: Date | null;
  automatic: number;
  reviews: number;
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
interface DayCountRow extends RowDataPacket {
  d: string;
  n: number;
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

export const moderationHealthService = {
  async report(days: number, now: Date = new Date()): Promise<ModerationHealth> {
    const since = new Date(now.getTime() - days * DAY_MS);
    const [
      [queue],
      [appealQueue],
      [decisionCounts],
      [decisionSecs],
      [automatic],
      [flaggedByDay],
      [appealCounts],
      [appealSecs],
      [removals],
      slaHours,
    ] = await Promise.all([
      pool.query<QueueRow[]>(
        `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest,
                COALESCE(SUM(reporter_id IS NULL), 0) AS automatic,
                COALESCE(SUM(target_type = 'user' AND description LIKE 'Reincidência:%'), 0) AS reviews
           FROM content_reports WHERE status IN ('pending', 'reviewing')`,
      ),
      pool.query<AppealQueueRow[]>(
        `SELECT COUNT(*) AS pending, MIN(appealed_at) AS oldest
           FROM content_removals WHERE status = 'appealed'`,
      ),
      pool.query<DayStatusCountRow[]>(
        `SELECT ${DAY_BRT('reviewed_at')} AS d, status, COUNT(*) AS n FROM content_reports
          WHERE status IN ('actioned', 'dismissed') AND reviewed_at >= :since
          GROUP BY d, status`,
        { since },
      ),
      pool.query<DaySecondsRow[]>(
        `SELECT ${DAY_BRT('reviewed_at')} AS d, TIMESTAMPDIFF(SECOND, created_at, reviewed_at) AS secs
           FROM content_reports
          WHERE status IN ('actioned', 'dismissed') AND reviewed_at >= :since
          ORDER BY reviewed_at DESC
          LIMIT ${SAMPLE_LIMIT}`,
        { since },
      ),
      pool.query<(AutomaticRow & RowDataPacket)[]>(
        `SELECT r.status, m.off_platform, COUNT(*) AS n
           FROM content_reports r
           LEFT JOIN messages m ON r.target_type = 'message' AND m.id = r.target_id
          WHERE r.reporter_id IS NULL AND r.created_at >= :since
          GROUP BY r.status, m.off_platform`,
        { since },
      ),
      pool.query<DayCountRow[]>(
        `SELECT ${DAY_BRT('created_at')} AS d, COUNT(*) AS n FROM content_reports
          WHERE reporter_id IS NULL AND created_at >= :since
          GROUP BY d`,
        { since },
      ),
      pool.query<StatusCountRow[]>(
        `SELECT status, COUNT(*) AS n FROM content_removals
          WHERE status IN ('upheld', 'overturned') AND appealed_at IS NOT NULL
            AND decided_at >= :since
          GROUP BY status`,
        { since },
      ),
      pool.query<SecondsRow[]>(
        `SELECT TIMESTAMPDIFF(SECOND, appealed_at, decided_at) AS secs
           FROM content_removals
          WHERE status IN ('upheld', 'overturned') AND appealed_at IS NOT NULL
            AND decided_at >= :since
          ORDER BY decided_at DESC
          LIMIT ${SAMPLE_LIMIT}`,
        { since },
      ),
      pool.query<RemovalTypeRow[]>(
        `SELECT target_type, COUNT(*) AS n FROM content_removals
          WHERE removed_at >= :since GROUP BY target_type ORDER BY n DESC`,
        { since },
      ),
      settingsService.number('moderation_sla_hours'),
    ]);
    const q = queue[0];
    const aq = appealQueue[0];
    const dismissed = countOf(decisionCounts, 'dismissed');
    const actioned = countOf(decisionCounts, 'actioned');
    const upheld = countOf(appealCounts, 'upheld');
    const overturned = countOf(appealCounts, 'overturned');
    const byType = removals.map((r) => ({ targetType: r.target_type, count: Number(r.n) }));
    return {
      windowDays: days,
      queue: {
        pending: Number(q?.pending ?? 0),
        oldestPendingAt: iso(q?.oldest),
        automaticPending: Number(q?.automatic ?? 0),
        accountReviewsOpen: Number(q?.reviews ?? 0),
        appealsPending: Number(aq?.pending ?? 0),
        oldestAppealAt: iso(aq?.oldest),
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
        flagged: flaggedByDay,
        seconds: decisionSecs,
      }),
    };
  },
};
