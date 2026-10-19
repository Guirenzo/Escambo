import type {
  BrazilTimezone,
  CreditReason,
  EarningsBucket,
  EarningsGranularity,
  WalletEarnings,
  WalletReason,
} from '@escambo/types';
import { z } from 'zod';
import { HttpError } from '../../utils/http-error';
import { addDaysToDay, dayIn } from '../../utils/timezone';
import { isCalendarDay } from './wallet.period';

/**
 * Ganhos do freelancer por período (RF-082), lidos do ledger de R$ sem recalcular nada: o que conta
 * é o que entrou no saldo DISPONÍVEL dele por trabalho feito.
 *
 * - `escrow_release`: o escrow liberado ao freelancer (conclusão, marco aprovado, cancelamento ou
 *   disputa com parte dele). O `amount` da linha já é só a fração liberada: o que voltou ao cliente
 *   nunca foi dele, então o estorno já vem descontado na própria linha.
 * - `barter_in`: a torna recebida na troca concluída, já sem a taxa (ADR 16).
 *
 * Ficam de fora: `escrow_in` (dinheiro retido, que ainda pode voltar ao cliente), `escrow_refund`
 * (escrow devolvido; não mexe no disponível), depósitos, reembolsos e saques (dinheiro do próprio
 * bolso indo e voltando). Nenhum caminho devolve ao cliente um valor já liberado, então não há
 * estorno posterior a descontar em R$.
 */
export const EARNING_REASONS = [
  'escrow_release',
  'barter_in',
] as const satisfies readonly WalletReason[];

/**
 * Créditos (time-bank): o ledger de créditos grava o TOTAL (disponível + escrow), e a liberação do
 * escrow não muda o total — a conclusão nem gera linha. Por isso os créditos contam quando entram
 * no escrow do freelancer (`escrow_in`, no aceite) e as devoluções (`escrow_refund` e a parte
 * negativa de `escrow_release` numa disputa) descontam no dia em que acontecem: o mesmo
 * reconhecimento que a receita da plataforma usa (ADR 26).
 */
export const CREDIT_EARNING_REASONS = [
  'escrow_in',
  'escrow_release',
  'escrow_refund',
] as const satisfies readonly CreditReason[];

/** O `IN (...)` de uma lista de motivos fixa (constantes do código, nunca entrada do usuário). */
export const reasonList = (reasons: readonly string[]): string =>
  `(${reasons.map((r) => `'${r}'`).join(', ')})`;

/** Teto de períodos no gráfico: 400 dias, semanas ou meses. */
export const MAX_BUCKETS = 400;

const day = z.string().refine(isCalendarDay, 'Informe um dia válido no formato AAAA-MM-DD');

/** Query dos ganhos: período em dias no fuso da conta (inclusivos) e o agrupamento. */
export const earningsQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
  granularity: z.enum(['day', 'week', 'month']).default('month'),
});
export type EarningsQuery = z.infer<typeof earningsQuerySchema>;

const two = (n: number): string => String(n).padStart(2, '0');

/** A segunda-feira da semana do dia (calendário puro). */
export function mondayOf(dayStr: string): string {
  const [y, m, d] = dayStr.split('-').map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = domingo
  return addDaysToDay(dayStr, -((weekday + 6) % 7));
}

/** O período do gráfico a que o dia pertence: o próprio dia, a segunda da semana ou "AAAA-MM". */
export function bucketOf(dayStr: string, granularity: EarningsGranularity): string {
  if (granularity === 'day') return dayStr;
  if (granularity === 'week') return mondayOf(dayStr);
  return dayStr.slice(0, 7);
}

/** O primeiro dia do mês `n` meses antes (ou depois, com n negativo) do mês do dia. */
function firstOfMonthShift(dayStr: string, n: number): string {
  const [y, m] = dayStr.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1 - n, 1));
  return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-01`;
}

function nextBucket(key: string, granularity: EarningsGranularity): string {
  if (granularity === 'day') return addDaysToDay(key, 1);
  if (granularity === 'week') return addDaysToDay(key, 7);
  return firstOfMonthShift(`${key}-01`, -1).slice(0, 7);
}

/** Os períodos de `from` a `to` (inclusivos), em ordem, com teto de `limit` + 1 para recusar. */
export function bucketKeys(
  from: string,
  to: string,
  granularity: EarningsGranularity,
  limit = MAX_BUCKETS,
): string[] {
  const last = bucketOf(to, granularity);
  const keys: string[] = [];
  for (let key = bucketOf(from, granularity); key <= last; key = nextBucket(key, granularity)) {
    keys.push(key);
    if (keys.length > limit) break;
  }
  return keys;
}

/** Período padrão terminando em `to`: 30 dias, 12 semanas (inteiras) ou 12 meses (inteiros). */
export function defaultFrom(to: string, granularity: EarningsGranularity): string {
  if (granularity === 'day') return addDaysToDay(to, -29);
  if (granularity === 'week') return addDaysToDay(mondayOf(to), -7 * 11);
  return firstOfMonthShift(to, 11);
}

const UNIT: Record<EarningsGranularity, string> = { day: 'dias', week: 'semanas', month: 'meses' };

/**
 * O período pedido, com os padrões: sem `to`, hoje (no fuso da conta); sem `from`, o padrão do
 * agrupamento até `to`. Invertido é 400 `invalid_range`, como no extrato; longo demais para o
 * agrupamento, 400 `range_too_long`.
 */
export function resolveEarningsPeriod(
  q: EarningsQuery,
  today: string,
): { from: string; to: string; keys: string[] } {
  const to = q.to ?? today;
  const from = q.from ?? defaultFrom(to, q.granularity);
  if (from > to) {
    throw new HttpError(
      400,
      'Período inválido: a data inicial precisa ser até a final',
      'invalid_range',
    );
  }
  const keys = bucketKeys(from, to, q.granularity);
  if (keys.length > MAX_BUCKETS) {
    throw new HttpError(
      400,
      `Período longo demais: no máximo ${MAX_BUCKETS} ${UNIT[q.granularity]} por gráfico`,
      'range_too_long',
    );
  }
  return { from, to, keys };
}

/** Uma linha de ganho do ledger de R$, já com os números convertidos. */
export interface EarningEntry {
  id: number;
  amount: number;
  reason: (typeof EARNING_REASONS)[number];
  contractId: number | null;
  createdAt: Date;
}

const cents = (v: number): number => Math.round(v * 100);
const reais = (c: number): number => c / 100;

/**
 * Soma as linhas por período no fuso da conta. Contratações são contadas por id distinto (no total
 * e em cada período); uma liberação sem contrato (contrato apagado) conta como um pagamento à parte.
 * Somas em centavos, para não acumular erro de ponto flutuante.
 */
export function summarizeEarnings(
  entries: readonly EarningEntry[],
  zone: BrazilTimezone,
  granularity: EarningsGranularity,
  keys: readonly string[],
): Pick<WalletEarnings, 'series' | 'totals'> {
  const acc = new Map<string, { cents: number; contracts: Set<string>; barters: number }>(
    keys.map((k) => [k, { cents: 0, contracts: new Set(), barters: 0 }]),
  );
  const allContracts = new Set<string>();
  let total = 0;
  let barters = 0;
  for (const e of entries) {
    const b = acc.get(bucketOf(dayIn(zone, e.createdAt), granularity));
    if (!b) continue; // fora do período pedido: a consulta já filtra, isto é só a guarda
    const c = cents(e.amount);
    b.cents += c;
    total += c;
    if (e.reason === 'barter_in') {
      b.barters += 1;
      barters += 1;
    } else {
      const key = e.contractId != null ? `c${e.contractId}` : `t${e.id}`;
      b.contracts.add(key);
      allContracts.add(key);
    }
  }
  const series: EarningsBucket[] = keys.map((bucket) => {
    const b = acc.get(bucket)!;
    return { bucket, amount: reais(b.cents), contracts: b.contracts.size, barters: b.barters };
  });
  const paid = allContracts.size + barters;
  return {
    series,
    totals: {
      amount: reais(total),
      contracts: allContracts.size,
      barters,
      averageTicket: paid > 0 ? reais(Math.round(total / paid)) : null,
    },
  };
}
