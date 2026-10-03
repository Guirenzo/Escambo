import type { BrazilTimezone } from '@escambo/types';

/**
 * Fusos do Brasil (ADR 46). O país não tem horário de verão desde 2019, então cada fuso é um
 * deslocamento fixo, mas as contas usam o fuso IANA, e não o deslocamento: se o horário de verão
 * voltar para uma parte do país, basta o ICU do Node saber. Tudo aqui é puro e cacheado.
 */

export const BRAZIL_TIMEZONES = [
  'America/Noronha',
  'America/Sao_Paulo',
  'America/Cuiaba',
  'America/Manaus',
  'America/Rio_Branco',
] as const satisfies readonly BrazilTimezone[];

/** Brasília: o fuso de quem não escolheu, e o dos jobs com hora única da plataforma. */
export const DEFAULT_TIMEZONE: BrazilTimezone = 'America/Sao_Paulo';

export const TIMEZONE_LABEL: Record<BrazilTimezone, string> = {
  'America/Noronha': 'Fernando de Noronha',
  'America/Sao_Paulo': 'Brasília',
  'America/Cuiaba': 'Cuiabá e Campo Grande',
  'America/Manaus': 'Manaus',
  'America/Rio_Branco': 'Rio Branco',
};

export const isBrazilTimezone = (value: unknown): value is BrazilTimezone =>
  typeof value === 'string' && (BRAZIL_TIMEZONES as readonly string[]).includes(value);

/** O fuso da conta, ou Brasília quando não há escolha (ou a coluna trouxe algo fora da lista). */
export const timezoneOf = (value: string | null | undefined): BrazilTimezone =>
  isBrazilTimezone(value) ? value : DEFAULT_TIMEZONE;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: BrazilTimezone): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
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
    partsFormatters.set(zone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Dia da semana no fuso (0 = domingo … 6 = sábado). */
  weekday: number;
}

/** Data e hora do instante `at` no fuso, em números. */
export function localParts(zone: BrazilTimezone, at: Date): LocalParts {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFormatter(zone).formatToParts(at)) {
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

/** Hora do dia (0 a 23) no fuso. */
export const hourIn = (zone: BrazilTimezone, at: Date): number => localParts(zone, at).hour;

/** Deslocamento do fuso em minutos no instante `at`: negativo a oeste de Greenwich. */
export function offsetMinutes(zone: BrazilTimezone, at: Date): number {
  const p = localParts(zone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Meia-noite de hoje no fuso, como instante UTC (o "hoje" é o do fuso, não o de Greenwich). */
export function startOfTodayIn(zone: BrazilTimezone, at: Date): Date {
  const p = localParts(zone, at);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - offsetMinutes(zone, at) * 60_000);
}

/** Data no fuso, como aparece nos avisos: "29/09/2026" (ADR 46 e 56). */
export function formatDate(at: Date, zone: BrazilTimezone): string {
  const p = localParts(zone, at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(p.day)}/${two(p.month)}/${p.year}`;
}

/** Data e hora no fuso, como aparecem nos avisos: "29/09/2026 às 12:00". */
export function formatDateTime(at: Date, zone: BrazilTimezone): string {
  const p = localParts(zone, at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(p.day)}/${two(p.month)}/${p.year} às ${two(p.hour)}:${two(p.minute)}`;
}

const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;

/**
 * Hora-limite de um prazo, no fuso de quem lê e vai agir (ADR 57): "sex, 02/10 às 09:00". O dia
 * da semana ajuda a situar; o ano sai porque esses instantes ficam a dias de distância.
 */
export function formatDue(at: Date, zone: BrazilTimezone): string {
  const p = localParts(zone, at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${WEEKDAY[p.weekday]}, ${two(p.day)}/${two(p.month)} às ${two(p.hour)}:${two(p.minute)}`;
}

/** O instante em que o relógio de parede do fuso marca essa data e hora (o dia pode transbordar). */
export function localInstant(
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

const two = (n: number): string => String(n).padStart(2, '0');
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** O dia do instante no fuso, como "2026-10-02". */
export function dayIn(zone: BrazilTimezone, at: Date): string {
  const p = localParts(zone, at);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

/** Soma dias a um "AAAA-MM-DD" (calendário puro, sem fuso). */
export function addDaysToDay(day: string, n: number): string {
  const m = DAY.exec(day);
  if (!m) throw new Error(`dia inválido: ${day}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** 23:59:59 do dia no fuso: o fim do dia de um prazo (ADR 58). */
export function endOfDayIn(zone: BrazilTimezone, day: string): Date {
  const m = DAY.exec(day);
  if (!m) throw new Error(`dia inválido: ${day}`);
  return localInstant(zone, Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59);
}

/** Os dois fusos marcam a mesma hora nesse instante (Manaus e Cuiabá, hoje). */
export const sameClock = (a: BrazilTimezone, b: BrazilTimezone, at: Date): boolean =>
  offsetMinutes(a, at) === offsetMinutes(b, at);

/** Depois dos preferidos, um nome por relógio (Cuiabá só entra quando é o fuso de uma das partes). */
export const DEADLINE_ZONE_FALLBACK: readonly BrazilTimezone[] = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Noronha',
  'America/Rio_Branco',
];

/**
 * O fuso em que o prazo é um dia (ADR 58): aquele em que o instante marca 23:59:59, procurando
 * primeiro nos preferidos (quem entrega, depois o cliente) e depois um nome por relógio. Um instante
 * só é 23:59:59 num relógio, então as duas partes leem o mesmo dia. Se nenhum bater (contratação
 * antiga, chamada direta à API), fica o primeiro preferido e a tela mostra a hora real ("até 20:59").
 * Só diz o dia: nenhum job usa (os prazos agem no fuso atual de quem é afetado, ADR 57).
 */
export function inferDeadlineZone(at: Date, prefer: readonly BrazilTimezone[]): BrazilTimezone {
  for (const zone of [...prefer, ...DEADLINE_ZONE_FALLBACK]) {
    const p = localParts(zone, at);
    if (p.hour === 23 && p.minute === 59 && p.second === 59) return zone;
  }
  return prefer[0] ?? DEFAULT_TIMEZONE;
}

/**
 * " (horário de Manaus)" quando quem lê está em outro RELÓGIO (Manaus e Cuiabá não se anotam);
 * sem leitor (histórico, mediação), sempre.
 */
export function deadlineZoneNote(at: Date, zone: BrazilTimezone, reader?: BrazilTimezone): string {
  return reader && sameClock(zone, reader, at) ? '' : ` (horário de ${TIMEZONE_LABEL[zone]})`;
}

/** O prazo como dia (ADR 58): "sex, 02/10/2026, até 23:59" no fuso do prazo, mais a nota do fuso. */
export function formatDeadline(at: Date, zone: BrazilTimezone, reader?: BrazilTimezone): string {
  const p = localParts(zone, at);
  return `${WEEKDAY[p.weekday]}, ${two(p.day)}/${two(p.month)}/${p.year}, até ${two(p.hour)}:${two(p.minute)}${deadlineZoneNote(at, zone, reader)}`;
}

/** Só o dia do prazo, para títulos: "sex, 02/10". */
export function formatDeadlineDay(at: Date, zone: BrazilTimezone): string {
  const p = localParts(zone, at);
  return `${WEEKDAY[p.weekday]}, ${two(p.day)}/${two(p.month)}`;
}
