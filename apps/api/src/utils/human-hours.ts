import type { BrazilTimezone } from '@escambo/types';
import { BRAZIL_TIMEZONES, localParts, offsetMinutes } from './timezone';

/**
 * A hora humana do prazo (ADR 57, R-HORA): nada automático por prazo acontece entre 21h e 9h no
 * fuso de quem é afetado. Duas faixas, de propósito:
 *  - instantes GRAVADOS (fim da carência, aprovação tácita, validade da proposta, resposta à
 *    extensão) caem em [09:00, 20:30): o que cairia fora passa para as 9h seguintes, nunca antes;
 *  - os jobs EMITEM em [09:00, 21:00) no fuso: 30 min (6 rodadas de 5 min) de folga para o
 *    instante gravado às 20:29 sair antes das 21h.
 * Tudo puro, sobre o fuso IANA (ADR 46): sem horário de verão hoje, mas sem supor deslocamento fixo.
 */

const H = 3_600_000;
const START_MIN = 9 * 60;
const RECORD_END_MIN = 20 * 60 + 30;
const EMIT_END_MIN = 21 * 60;

/** Minuto do dia (0 a 1439) do instante no fuso. */
function minuteOfDay(zone: BrazilTimezone, at: Date): number {
  const p = localParts(zone, at);
  return p.hour * 60 + p.minute;
}

/** O instante em que o relógio de parede do fuso marca essa data e hora (o dia pode transbordar). */
function localInstant(
  zone: BrazilTimezone,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = naive - offsetMinutes(zone, new Date(naive)) * 60_000;
  return new Date(naive - offsetMinutes(zone, new Date(guess)) * 60_000);
}

/** O DATETIME do MySQL arredonda a fração: tudo o que se grava e se compara por igualdade vai sem ela. */
export const floorSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** Portão de emissão dos jobs: 09:00 ≤ hora < 21:00 no fuso. */
export function inHumanHours(zone: BrazilTimezone, at: Date): boolean {
  const m = minuteOfDay(zone, at);
  return m >= START_MIN && m < EMIT_END_MIN;
}

/** O instante está na faixa em que se grava: 09:00 ≤ hora < 20:30 no fuso. */
export function isHumanInstant(at: Date, zone: BrazilTimezone): boolean {
  const m = minuteOfDay(zone, at);
  return m >= START_MIN && m < RECORD_END_MIN;
}

/** O instante, se cair entre 09:00 e 20:30 no fuso; senão, as 9h seguintes. Nunca antes. */
export function humanize(at: Date, zone: BrazilTimezone): Date {
  if (isHumanInstant(at, zone)) return at;
  const p = localParts(zone, at);
  const nextDay = p.hour * 60 + p.minute >= RECORD_END_MIN ? 1 : 0;
  return localInstant(zone, p.year, p.month, p.day + nextDay, 9, 0, 0);
}

/** O instante, se cair entre 09:00 e 20:30; senão, as 20:29:59 anteriores. Nunca depois. */
export function lastHumanAtOrBefore(at: Date, zone: BrazilTimezone): Date {
  if (isHumanInstant(at, zone)) return at;
  const p = localParts(zone, at);
  const previousDay = p.hour * 60 + p.minute < START_MIN ? 1 : 0;
  return localInstant(zone, p.year, p.month, p.day - previousDay, 20, 29, 59);
}

/**
 * Soma `hours` contando só o tempo dentro de [09:00, 20:30) no fuso: o piso "de dia" depois de uma
 * decisão (a recusa às 20:29 com 6 h dá 14:59 do dia seguinte, e não as 9h).
 */
export function addHumanHours(from: Date, hours: number, zone: BrazilTimezone): Date {
  let t = humanize(from, zone);
  let left = hours * H;
  for (let i = 0; i < 400; i++) {
    const p = localParts(zone, t);
    const windowEnd = localInstant(zone, p.year, p.month, p.day, 20, 30, 0).getTime();
    const available = windowEnd - t.getTime();
    if (left < available) return new Date(t.getTime() + left);
    left -= available;
    t = localInstant(zone, p.year, p.month, p.day + 1, 9, 0, 0);
  }
  return t;
}

/** Fusos em que é dia agora: é por eles que os jobs de prazo filtram quem é afetado. */
export const dayZones = (now: Date): BrazilTimezone[] =>
  BRAZIL_TIMEZONES.filter((z) => inHumanHours(z, now));
