import type { FinanceGranularity } from '@escambo/types';
import { HttpError } from '../../utils/http-error';

/**
 * Períodos dos relatórios do admin (financeiro e uso), sempre em dias de Brasília. O banco guarda
 * UTC; aqui um dia AAAA-MM-DD vira o intervalo [03:00 UTC do dia, 03:00 UTC do dia seguinte).
 * A semana vai de segunda a domingo; o balde da semana é a segunda-feira dela.
 */

export const DAY_MS = 86_400_000;
/** Deslocamento fixo de Brasília (o país não tem horário de verão desde 2019). */
const BRT_OFFSET_HOURS = 3;
const MAX_DAYS = 400;

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
/** Soma dias a um AAAA-MM-DD (aritmética em UTC, sem fuso no meio). */
export const addDaysIso = (day: string, n: number): string =>
  isoDate(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS));

/** Hoje em Brasília, como AAAA-MM-DD. */
export function todayBrt(now: Date = new Date()): string {
  return isoDate(new Date(now.getTime() - BRT_OFFSET_HOURS * 3_600_000));
}

/** Limites do período: dias de Brasília → instantes UTC (`to` é exclusivo, começo do dia seguinte). */
export function bounds(from: string, to: string): { fromUtc: Date; toUtc: Date } {
  const fromUtc = new Date(`${from}T0${BRT_OFFSET_HOURS}:00:00Z`);
  const toUtc = new Date(new Date(`${to}T0${BRT_OFFSET_HOURS}:00:00Z`).getTime() + DAY_MS);
  return { fromUtc, toUtc };
}

/** A segunda-feira da semana do dia (getUTCDay: domingo = 0). */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDaysIso(day, -((dow + 6) % 7));
}

/** O primeiro dia do mês do dia. */
export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;

/** O último dia do mês do dia. */
export function monthEnd(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return isoDate(new Date(Date.UTC(y!, m!, 0)));
}

/**
 * Período padrão, sempre até hoje: últimos 30 dias (por dia), últimas 12 semanas contando a atual
 * (por semana) ou últimos 6 meses contando o atual (por mês).
 */
export function defaultRange(
  granularity: FinanceGranularity,
  now: Date = new Date(),
): {
  from: string;
  to: string;
} {
  const to = todayBrt(now);
  if (granularity === 'day') return { from: addDaysIso(to, -29), to };
  if (granularity === 'week') return { from: addDaysIso(weekStart(to), -11 * 7), to };
  const [y, m] = to.split('-').map(Number);
  const start = new Date(Date.UTC(y!, m! - 1 - 5, 1));
  return { from: isoDate(start), to };
}

export interface ResolvedPeriod {
  from: string;
  to: string;
  fromUtc: Date;
  toUtc: Date;
}

/** Período pedido (ou o padrão), validado: invertido, inexistente ou longo demais é 400. */
export function resolvePeriod(q: {
  from?: string;
  to?: string;
  granularity: FinanceGranularity;
}): ResolvedPeriod {
  const def = defaultRange(q.granularity);
  const from = q.from ?? def.from;
  const to = q.to ?? def.to;
  const { fromUtc, toUtc } = bounds(from, to);
  if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime()) || fromUtc >= toUtc) {
    throw new HttpError(
      400,
      'Período inválido: a data inicial precisa ser até a final',
      'invalid_range',
    );
  }
  if ((toUtc.getTime() - fromUtc.getTime()) / DAY_MS > MAX_DAYS) {
    throw new HttpError(400, `Período máximo de ${MAX_DAYS} dias`, 'range_too_long');
  }
  return { from, to, fromUtc, toUtc };
}

/** Um balde do período: a chave e os dias que ele cobre por inteiro e dentro do pedido. */
export interface PeriodBucket {
  /** "AAAA-MM-DD" (dia; na semana, a segunda) ou "AAAA-MM" (mês), como o SQL agrupa. */
  key: string;
  /** Começo e fim do dia, semana ou mês inteiro. */
  start: string;
  end: string;
  /** O balde inteiro está dentro do período pedido (sem corte na ponta). */
  whole: boolean;
}

/** Todos os baldes de `from` a `to`, em ordem, inclusive os que não terão movimento. */
export function bucketsIn(
  from: string,
  to: string,
  granularity: FinanceGranularity,
): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  let start =
    granularity === 'day' ? from : granularity === 'week' ? weekStart(from) : monthStart(from);
  while (start <= to) {
    const end =
      granularity === 'day'
        ? start
        : granularity === 'week'
          ? addDaysIso(start, 6)
          : monthEnd(start);
    out.push({
      key: granularity === 'month' ? start.slice(0, 7) : start,
      start,
      end,
      whole: start >= from && end <= to,
    });
    start = addDaysIso(end, 1);
  }
  return out;
}
