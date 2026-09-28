import { clock, setClockForTests } from '../../src/utils/clock';

/**
 * Relógio dos testes de prazo (ADR 57). Os jobs de prazo só agem de dia no fuso de quem é afetado,
 * então os testes põem o relógio do fluxo às 12:00 de Brasília do dia de hoje (dia nos 5 fusos) e
 * deixam andar; as linhas do banco são montadas em relação a ele (nunca com NOW() do MySQL). A CI
 * roda a qualquer hora: sem isso, os testes quebrariam à noite.
 */

const H = 3_600_000;

/** 12:00 de Brasília (UTC−3) no dia de hoje em Brasília. */
export function noonBrasilia(from: Date = new Date()): Date {
  const local = new Date(from.getTime() - 3 * H);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 15, 0, 0),
  );
}

/** Liga o relógio diurno e devolve o instante em que ele começou. */
export function startDaytimeClock(at: Date = noonBrasilia()): Date {
  setClockForTests(at);
  return at;
}

export function stopClock(): void {
  setClockForTests(null);
}

/** O agora do fluxo, sem milissegundos (o DATETIME do MySQL guarda até o segundo). */
export function now(): Date {
  const d = clock.now();
  d.setMilliseconds(0);
  return d;
}

/** `ms` a partir do agora do fluxo, sem milissegundos. */
export const fromNow = (ms: number): Date => new Date(now().getTime() + ms);

/** O mesmo, em ISO (para mandar à API). */
export const isoFromNow = (ms: number): string => fromNow(ms).toISOString();

export const HOUR = H;
export const DAY = 24 * H;
