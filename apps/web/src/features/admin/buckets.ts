import type { FinanceGranularity } from '@escambo/types';

/** "por dia", "por semana", "por mês". */
export const GRANULARITY_WORD: Record<FinanceGranularity, string> = {
  day: 'dia',
  week: 'semana',
  month: 'mês',
};

const DAY_MS = 86_400_000;
/** "2026-09-14" → "14/09". */
const ddmm = (day: string): string => `${day.slice(8)}/${day.slice(5, 7)}`;
const plusDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Rótulo curto, do eixo: "2026-09" → "09/2026"; "2026-09-14" → "14/09" (na semana, a segunda). */
export const bucketLabel = (b: string): string =>
  b.length === 7 ? `${b.slice(5)}/${b.slice(0, 4)}` : ddmm(b);

/** Rótulo completo, da tabela e da dica: a semana vira "07/09 a 13/09" (segunda a domingo). */
export const bucketFullLabel = (b: string, granularity: FinanceGranularity): string =>
  granularity === 'week' ? `${ddmm(b)} a ${ddmm(plusDays(b, 6))}` : bucketLabel(b);
