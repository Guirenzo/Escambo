import type { BrazilTimezone } from '@escambo/types';
import { BRAZIL_TIMEZONES, localInstant, localParts } from './timezone';

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

/** Teto do intervalo dos jobs (config/env.ts): os lembretes contam com ele para o slot sair. */
export const JOBS_INTERVAL_MAX_MS = 30 * 60_000;
/** Véspera: as 9h mais recentes com pelo menos 24 h pela frente (ADR 58). */
export const REMINDER_LEAD_MS = 24 * H;
/** Nunca nas 12 h depois de a pessoa saber do vencimento (vale para os dois slots). */
export const REMINDER_MIN_AGE_MS = 12 * H;
/** Emissão: nunca com menos de 2 h pela frente. */
export const REMINDER_MIN_LEFT_MS = 2 * H;
/** Escolha do slot do próprio dia: as 2 h da emissão mais o teto do intervalo dos jobs (2 h 30). */
export const REMINDER_SLOT_MIN_LEFT_MS = REMINDER_MIN_LEFT_MS + JOBS_INTERVAL_MAX_MS;
/** O slot fica sempre a menos de 48 h do vencimento: a janela das candidatas é [agora + 2 h, agora + 48 h). */
export const REMINDER_MAX_AHEAD_MS = 48 * H;

/** As 9h mais recentes, no fuso, que não passam de `at`. */
export function nineAtOrBefore(at: Date, zone: BrazilTimezone): Date {
  const p = localParts(zone, at);
  const today = localInstant(zone, p.year, p.month, p.day, 9, 0, 0);
  return today.getTime() <= at.getTime()
    ? today
    : localInstant(zone, p.year, p.month, p.day - 1, 9, 0, 0);
}

/**
 * Quando lembrar de um vencimento (ADR 58), no fuso de quem recebe:
 * 1) véspera: as 9h mais recentes com pelo menos 24 h pela frente, se a pessoa soube do vencimento
 *    há pelo menos 12 h nesse instante;
 * 2) senão, as 9h seguintes (o próprio dia), se também passaram 12 h e sobram pelo menos 2 h 30;
 * 3) senão, nenhum (null): o aviso que abriu a contagem já disse a hora.
 * `start` null = sem restrição de idade.
 */
export function reminderSlot(p: {
  start: Date | null;
  due: Date;
  zone: BrazilTimezone;
}): Date | null {
  const aged = (t: Date): boolean =>
    p.start === null || t.getTime() >= p.start.getTime() + REMINDER_MIN_AGE_MS;
  const eve = nineAtOrBefore(new Date(p.due.getTime() - REMINDER_LEAD_MS), p.zone);
  if (aged(eve)) return eve;
  const e = localParts(p.zone, eve);
  const day = localInstant(p.zone, e.year, e.month, e.day + 1, 9, 0, 0);
  return aged(day) && p.due.getTime() - day.getTime() >= REMINDER_SLOT_MIN_LEFT_MS ? day : null;
}

/** Sai agora? O slot já chegou, é dia (9h às 21h) no fuso de quem recebe e sobram pelo menos 2 h. */
export function reminderDue(p: {
  now: Date;
  slot: Date | null;
  due: Date;
  zone: BrazilTimezone;
}): boolean {
  return (
    p.slot !== null &&
    p.now.getTime() >= p.slot.getTime() &&
    inHumanHours(p.zone, p.now) &&
    p.due.getTime() - p.now.getTime() >= REMINDER_MIN_LEFT_MS
  );
}
