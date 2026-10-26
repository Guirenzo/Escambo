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

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Todos os baldes de `from` a `to` ("AAAA-MM-DD"), na mesma chave que a API agrupa: o dia, a
 * segunda-feira da semana ou "AAAA-MM". O financeiro só devolve os períodos com movimento; o
 * gráfico precisa dos vazios para o tempo não encolher (um mês parado é uma coluna zerada).
 */
export function allBuckets(from: string, to: string, granularity: FinanceGranularity): string[] {
  const out: string[] = [];
  if (granularity === 'month') {
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const end = to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > end) return out;
      out.push(key);
      [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  // Semana: começa na segunda (getUTCDay: domingo 0).
  const first =
    granularity === 'week' ? start - ((new Date(start).getUTCDay() + 6) % 7) * DAY_MS : start;
  const step = granularity === 'week' ? 7 : 1;
  for (let t = first; isoDay(t) <= to; t += step * DAY_MS) out.push(isoDay(t));
  return out;
}
