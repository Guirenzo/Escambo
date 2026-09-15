import type { AvailabilityPeriod, AvailablePeriods } from '@escambo/types';

/**
 * Horário de atendimento (ADR 34). O freelancer marca os dias (available_days) e, por dia, os
 * períodos (available_periods); dia sem períodos = o dia todo. "Atende agora" é calculado no
 * horário de Brasília — a plataforma inteira fala nesse fuso (resumo diário, expurgo, prazos).
 */

export const PERIODS: readonly AvailabilityPeriod[] = ['morning', 'afternoon', 'evening'];

/** Horas de início (inclusive) e fim (exclusive) de cada período, em Brasília. */
export const PERIOD_HOURS: Record<AvailabilityPeriod, readonly [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 24],
};

const BRT_OFFSET_MS = 3 * 3_600_000; // o país não tem horário de verão

/** Dia da semana (0 = domingo) e hora do dia em Brasília. */
export function brtClock(now: Date): { day: number; hour: number } {
  const brt = new Date(now.getTime() - BRT_OFFSET_MS);
  return { day: brt.getUTCDay(), hour: brt.getUTCHours() };
}

/** Período de uma hora (0–23); madrugada (0–6) não é período de atendimento. */
export function periodAt(hour: number): AvailabilityPeriod | null {
  return PERIODS.find((p) => hour >= PERIOD_HOURS[p][0] && hour < PERIOD_HOURS[p][1]) ?? null;
}

export interface Slot {
  day: number;
  period: AvailabilityPeriod | null;
}

/** Dia e período de agora, em Brasília. */
export function currentSlot(now: Date = new Date()): Slot {
  const { day, hour } = brtClock(now);
  return { day, period: periodAt(hour) };
}

/** JSON da coluna (objeto, string ou NULL) → períodos por dia; o que não for válido some. */
export function parsePeriods(v: unknown): AvailablePeriods | null {
  if (v == null) return null;
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const out: AvailablePeriods = {};
  for (const [key, list] of Object.entries(obj as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(key) || !Array.isArray(list)) continue;
    const periods = PERIODS.filter((p) => list.some((x) => x === p));
    if (periods.length > 0) out[key] = periods;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normaliza para a coluna: só dias que estão marcados, períodos sem repetição e em ordem, e dia
 * com nenhum ou com os três períodos sai do objeto (os dois significam "o dia todo"). Nada
 * restrito → null.
 */
export function normalizePeriods(
  days: number[] | null | undefined,
  periods: Record<string, string[]> | null | undefined,
): string | null {
  if (!days || days.length === 0 || !periods) return null;
  const marked = new Set(days);
  const out: AvailablePeriods = {};
  for (const day of [...marked].sort((a, b) => a - b)) {
    const list = periods[String(day)];
    if (!Array.isArray(list)) continue;
    const chosen = PERIODS.filter((p) => list.includes(p));
    if (chosen.length > 0 && chosen.length < PERIODS.length) out[String(day)] = chosen;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

export interface AvailabilityInput {
  isAvailable: boolean;
  availableDays: number[] | null;
  availablePeriods: AvailablePeriods | null;
}

/** Aceitando pedidos, atende hoje e está num período marcado (ou o dia é inteiro). */
export function isAvailableNow(a: AvailabilityInput, now: Date = new Date()): boolean {
  const { day, period } = currentSlot(now);
  if (!a.isAvailable || !period || !a.availableDays?.includes(day)) return false;
  const today = a.availablePeriods?.[String(day)];
  return !today || today.includes(period);
}
