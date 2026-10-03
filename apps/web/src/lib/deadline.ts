import type { Contract } from '@escambo/types';
import { WEEKDAY_SHORT } from './format';
import { DEFAULT_TIMEZONE, timezoneLabel } from './timezones';

/**
 * O relógio do prazo na tela (ADR 57 e 58). Duas coisas diferentes, de propósito:
 *  - as horas-limite que a API grava (aviso, disputa, resposta a um pedido, aprovação automática,
 *    validade da proposta) aparecem no fuso de quem lê, porque é ele quem vai agir;
 *  - o PRAZO é uma data e vale até 23:59 dela no fuso de quem entrega: as duas partes leem o mesmo
 *    dia, com "(horário de Manaus)" para quem está em outro relógio.
 * Espelho de utils/timezone.ts da API (mesma tabela de vetores nos testes).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function partsIn(zone: string, at: Date): Parts {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(zone).formatToParts(at)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return {
    year: p.year!,
    month: p.month!,
    day: p.day!,
    hour: p.hour!,
    minute: p.minute!,
    second: p.second!,
    weekday: new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay(),
  };
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Deslocamento do fuso em minutos no instante (negativo a oeste de Greenwich). */
function offsetMinutes(zone: string, at: Date): number {
  const p = partsIn(zone, at);
  return Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime()) / 60_000,
  );
}

/** "sáb, 03/10, às 09:00" no fuso de quem lê (Brasília para quem não escolheu). */
export function momentText(iso: string, zone: string | null | undefined): string {
  const p = partsIn(zone ?? DEFAULT_TIMEZONE, new Date(iso));
  return `${WEEKDAY_SHORT[p.weekday]}, ${two(p.day)}/${two(p.month)}, às ${two(p.hour)}:${two(p.minute)}`;
}

/** "2026-10-02": o dia do instante no fuso. */
export function dayIn(zone: string, at: Date | string): string {
  const p = partsIn(zone, new Date(at));
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

/** Hoje, no fuso (o "hoje" de quem entrega, para o mínimo do prazo). */
export const todayIn = (zone: string, now: Date = new Date()): string => dayIn(zone, now);

/** Soma dias a um "AAAA-MM-DD" (calendário puro, sem fuso). */
export function addDaysToDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + n));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** 23:59:59 do dia no fuso, em ISO: o fim do dia de um prazo. */
export function endOfDayIn(zone: string, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const naive = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 23, 59, 59);
  const guess = naive - offsetMinutes(zone, new Date(naive)) * 60_000;
  return new Date(naive - offsetMinutes(zone, new Date(guess)) * 60_000).toISOString();
}

/**
 * n dias entre `fromDay` (exclusivo) e `toDay` (inclusivo), espalhados por igual: o i-ésimo é
 * fromDay + ceil(span·(i+1)/n), e o último é sempre `toDay`. Só "AAAA-MM-DD", sem fuso.
 */
export function spreadDays(fromDay: string, toDay: string, n: number): string[] {
  const at = (day: string): number => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  };
  const span = Math.round((at(toDay) - at(fromDay)) / 86_400_000);
  return Array.from({ length: n }, (_, i) =>
    addDaysToDay(fromDay, Math.max(1, Math.ceil((span * (i + 1)) / n))),
  );
}

/** Os dois fusos marcam a mesma hora nesse instante (Manaus e Cuiabá, hoje). */
export const sameClock = (a: string, b: string, at: Date = new Date()): boolean =>
  offsetMinutes(a, at) === offsetMinutes(b, at);

/** "sex, 02/10/2026, até 23:59": o prazo como dia, no fuso dele. */
export function deadlineText(iso: string, zone: string): string {
  const p = partsIn(zone, new Date(iso));
  return `${WEEKDAY_SHORT[p.weekday]}, ${two(p.day)}/${two(p.month)}/${p.year}, até ${two(p.hour)}:${two(p.minute)}`;
}

/** " (horário de Manaus)" quando quem vê está em outro RELÓGIO; vazio no mesmo relógio. */
export function deadlineZoneNote(
  iso: string,
  zone: string,
  viewer: string | null | undefined,
): string {
  return sameClock(zone, viewer ?? DEFAULT_TIMEZONE, new Date(iso))
    ? ''
    : ` (horário de ${timezoneLabel(zone)})`;
}

/** "4 dias e 3 h", "5 h", "40 min": quanto falta até um instante. */
export function untilLabel(ms: number): string {
  if (ms <= 0) return '0 min';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours - days * 24;
  const d = days === 1 ? '1 dia' : `${days} dias`;
  return rest > 0 ? `${d} e ${rest} h` : d;
}

export interface DeadlineInfo {
  /** Dias de calendário até o prazo, no fuso do prazo (negativo = dias de atraso). */
  daysLeft: number;
  tone: 'ok' | 'soon' | 'late';
  label: string;
}

/**
 * O prazo em relação a agora, em dias de calendário NO FUSO DO PRAZO ("faltam 3 dias", "vence
 * amanhã", "atrasada há 2 dias"): as duas partes veem a mesma contagem.
 */
export function deadlineInfo(
  iso: string | null | undefined,
  zone: string,
  now: Date = new Date(),
): DeadlineInfo | null {
  if (!iso) return null;
  const deadline = new Date(iso);
  const at = (day: string): number => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  };
  const daysLeft = Math.round((at(dayIn(zone, deadline)) - at(dayIn(zone, now))) / 86_400_000);
  if (deadline.getTime() < now.getTime()) {
    const late = -daysLeft;
    return {
      daysLeft,
      tone: 'late',
      label:
        late <= 0 ? 'venceu hoje' : late === 1 ? 'atrasada há 1 dia' : `atrasada há ${late} dias`,
    };
  }
  if (daysLeft <= 0) return { daysLeft: 0, tone: 'soon', label: 'vence hoje' };
  if (daysLeft === 1) return { daysLeft: 1, tone: 'soon', label: 'vence amanhã' };
  return { daysLeft, tone: daysLeft <= 3 ? 'soon' : 'ok', label: `faltam ${daysLeft} dias` };
}

export interface DeadlinePill {
  tone: 'ok' | 'soon' | 'late' | 'paused' | 'met';
  label: string;
}

/**
 * A pílula do prazo, pelo estado que a API calculou: quanto falta enquanto corre; "venceu" antes
 * do aviso; "vencido" na carência; "extensão pedida" enquanto o cliente decide; "entregue" quando
 * não há mais o que cobrar. Sem prazo, proposta ou encerrada: nada.
 */
export function deadlinePill(
  c: Pick<Contract, 'deadlineAt' | 'deadline' | 'deadlineZone'>,
  now: Date = new Date(),
): DeadlinePill | null {
  switch (c.deadline?.state) {
    case 'running': {
      // Durante o deploy, a API antiga ainda não manda o fuso do prazo: vale Brasília.
      const info = deadlineInfo(c.deadlineAt, c.deadlineZone ?? DEFAULT_TIMEZONE, now);
      if (!info) return null;
      return info.tone === 'late'
        ? { tone: 'late', label: 'venceu' }
        : { tone: info.tone, label: info.label };
    }
    case 'due':
      return { tone: 'late', label: 'venceu' };
    case 'grace':
      return { tone: 'late', label: 'vencido' };
    case 'paused':
      return { tone: 'paused', label: 'extensão pedida' };
    case 'met':
      return { tone: 'met', label: 'entregue' };
    default:
      return null;
  }
}
