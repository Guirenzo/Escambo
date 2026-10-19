import type { BrazilTimezone } from '@escambo/types';
import { z } from 'zod';
import { HttpError } from '../../utils/http-error';
import { addDaysToDay, localInstant } from '../../utils/timezone';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "AAAA-MM-DD" que existe no calendário: 2026-02-30 e 2026-13-01 não passam. */
export function isCalendarDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** Período do extrato (RF-047): dias "AAAA-MM-DD" no fuso de quem lê, os dois inclusivos. */
export interface WalletPeriod {
  from?: string;
  to?: string;
}

/** O período como instantes UTC: `from` inclusivo, `to` exclusivo (meia-noite do dia seguinte). */
export interface WalletRange {
  from?: Date;
  to?: Date;
}

function startOfDay(zone: BrazilTimezone, day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return localInstant(zone, y!, m!, d!, 0, 0, 0);
}

/**
 * Dias do período → instantes UTC, no fuso da conta de quem lê (ADR 46): "de 01/10 até 01/10" em
 * Manaus vai das 04:00 de 01/10 às 04:00 de 02/10 em UTC. O fuso só é buscado quando há período, e
 * um período invertido é recusado antes disso.
 */
export async function periodRange(
  period: WalletPeriod,
  zoneOf: () => Promise<BrazilTimezone>,
): Promise<WalletRange> {
  if (!period.from && !period.to) return {};
  if (period.from && period.to && period.from > period.to) {
    throw new HttpError(
      400,
      'Período inválido: a data inicial precisa ser até a final',
      'invalid_range',
    );
  }
  const zone = await zoneOf();
  const range: WalletRange = {};
  if (period.from) range.from = startOfDay(zone, period.from);
  if (period.to) range.to = startOfDay(zone, addDaysToDay(period.to, 1));
  return range;
}

/** Dia do período do extrato: "AAAA-MM-DD" que existe no calendário. */
const day = z.string().refine(isCalendarDay, 'Informe um dia válido no formato AAAA-MM-DD');

/**
 * Query dos dois extratos (R$ e créditos, RF-047): página, tamanho da página e o período em dias
 * no fuso da conta, os dois inclusivos.
 */
export const ledgerQuerySchema = z.object({
  // Teto na página: sem ele, ?page=1e20 vira OFFSET 2e+21 e o MySQL recusa (500).
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  from: day.optional(),
  to: day.optional(),
});

/**
 * O período como filtro SQL da data do lançamento (`created_at`, em UTC): início inclusivo, fim
 * exclusivo. Sem período, filtro vazio. Os parâmetros entram nos nomeados da consulta.
 */
export function rangeFilter(range: WalletRange): { sql: string; params: WalletRange } {
  let sql = '';
  const params: WalletRange = {};
  if (range.from) {
    sql += ' AND created_at >= :from';
    params.from = range.from;
  }
  if (range.to) {
    sql += ' AND created_at < :to';
    params.to = range.to;
  }
  return { sql, params };
}

/**
 * Uma página do extrato a partir de até `limit + 1` linhas: a que sobra não aparece, só diz que há
 * outra página ("Carregar mais").
 */
export function ledgerPage<Row, Item>(
  rows: Row[],
  page: number,
  limit: number,
  map: (row: Row) => Item,
): { items: Item[]; page: number; limit: number; hasMore: boolean } {
  return { items: rows.slice(0, limit).map(map), page, limit, hasMore: rows.length > limit };
}
