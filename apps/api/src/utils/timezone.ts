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

/** Data e hora no fuso, como aparecem nos avisos: "29/09/2026 às 12:00". */
export function formatDateTime(at: Date, zone: BrazilTimezone): string {
  const p = localParts(zone, at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(p.day)}/${two(p.month)}/${p.year} às ${two(p.hour)}:${two(p.minute)}`;
}
