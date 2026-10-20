import { logger } from '../config/logger';
import { addDaysIso, monthStart, todayBrt, weekStart } from '../modules/admin/report-period';
import { usageRepository, type SnapshotType } from '../modules/admin/usage.repository';
import { usageService } from '../modules/admin/usage.service';
import { clock } from '../utils/clock';

/**
 * Snapshots dos relatórios (RF-081): a cada rodada, grava o que falta dos períodos já fechados em
 * Brasília: os últimos 7 dias, a última semana inteira (segunda a domingo) e o último mês inteiro.
 * O normal é gravar só o dia de ontem (e, na segunda e no dia 1º, a semana e o mês que fecharam);
 * os 7 dias cobrem a API que ficou fora do ar. Período que já tem snapshot não é recalculado, e a
 * chave única do banco segura duas instâncias gravando o mesmo período: rodar de novo não muda nada.
 */

/** Folga depois da meia-noite: uma gravação que começou às 23:59:59 ainda entra no dia certo. */
export const SNAPSHOT_MARGIN_MS = 15 * 60_000;
const DAYS_BACK = 7;

export interface ReportSnapshotsResult {
  /** O último dia fechado em Brasília. */
  closedDay: string;
  /** O que esta rodada gravou, como "tipo:início" (ex.: "daily:2026-10-18"). */
  written: string[];
  failed: string[];
}

interface Period {
  type: SnapshotType;
  start: string;
  end: string;
}

/** Os períodos fechados que a rodada confere, do mais antigo ao mais novo. */
export function closedPeriods(now: Date): { closedDay: string; periods: Period[] } {
  const closedDay = addDaysIso(todayBrt(new Date(now.getTime() - SNAPSHOT_MARGIN_MS)), -1);
  const periods: Period[] = [];
  for (let i = DAYS_BACK - 1; i >= 0; i--) {
    const day = addDaysIso(closedDay, -i);
    periods.push({ type: 'daily', start: day, end: day });
  }
  // O domingo e o último dia de mês mais recentes até o último dia fechado (podem ser ele mesmo).
  const after = addDaysIso(closedDay, 1);
  const sunday = addDaysIso(weekStart(after), -1);
  periods.push({ type: 'weekly', start: weekStart(sunday), end: sunday });
  const monthEnd = addDaysIso(monthStart(after), -1);
  periods.push({ type: 'monthly', start: monthStart(monthEnd), end: monthEnd });
  return { closedDay, periods };
}

export async function runReportSnapshots(now: Date = clock.now()): Promise<ReportSnapshotsResult> {
  const { closedDay, periods } = closedPeriods(now);
  const since = periods.reduce((min, p) => (p.start < min ? p.start : min), closedDay);
  const done = await usageRepository.existing(since);
  const result: ReportSnapshotsResult = { closedDay, written: [], failed: [] };
  for (const p of periods) {
    const id = `${p.type}:${p.start}`;
    if (done.has(id)) continue;
    try {
      if (await usageService.snapshot(p.type, p.start, p.end)) result.written.push(id);
    } catch (err) {
      // Um período que falhou não segura os outros; a próxima rodada tenta de novo.
      result.failed.push(id);
      logger.warn({ err, snapshot: id }, 'snapshot do relatório não gravado');
    }
  }
  return result;
}
