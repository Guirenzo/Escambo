import type { BrazilTimezone } from '@escambo/types';

/**
 * Fusos do Brasil que a conta pode escolher (ADR 46), na ordem de leste para oeste. A mesma lista
 * fechada da API (apps/api/src/utils/timezone.ts): mudou lá, muda aqui.
 */
export const TIMEZONE_OPTIONS: { value: BrazilTimezone; label: string; hint: string }[] = [
  { value: 'America/Noronha', label: 'Fernando de Noronha', hint: 'UTC−2' },
  { value: 'America/Sao_Paulo', label: 'Brasília', hint: 'UTC−3' },
  { value: 'America/Cuiaba', label: 'Cuiabá e Campo Grande', hint: 'UTC−4' },
  { value: 'America/Manaus', label: 'Manaus', hint: 'UTC−4' },
  { value: 'America/Rio_Branco', label: 'Rio Branco', hint: 'UTC−5' },
];

/** O fuso de quem não escolheu. */
export const DEFAULT_TIMEZONE: BrazilTimezone = 'America/Sao_Paulo';

/**
 * Fusos IANA do Brasil que o navegador pode informar, cada um no fuso da conta que tem o mesmo
 * relógio (ADR 51). Belém, Fortaleza, Recife e Salvador marcam a hora de Brasília; Porto Velho e
 * Boa Vista, a de Manaus; Eirunepé, a de Rio Branco. Os nomes antigos (Brazil/...) também valem.
 */
const BROWSER_ZONES: Record<string, BrazilTimezone> = {
  'America/Noronha': 'America/Noronha',
  'Brazil/DeNoronha': 'America/Noronha',
  'America/Sao_Paulo': 'America/Sao_Paulo',
  'Brazil/East': 'America/Sao_Paulo',
  'America/Fortaleza': 'America/Sao_Paulo',
  'America/Recife': 'America/Sao_Paulo',
  'America/Bahia': 'America/Sao_Paulo',
  'America/Belem': 'America/Sao_Paulo',
  'America/Maceio': 'America/Sao_Paulo',
  'America/Araguaina': 'America/Sao_Paulo',
  'America/Santarem': 'America/Sao_Paulo',
  'America/Cuiaba': 'America/Cuiaba',
  'America/Campo_Grande': 'America/Cuiaba',
  'America/Manaus': 'America/Manaus',
  'Brazil/West': 'America/Manaus',
  'America/Porto_Velho': 'America/Manaus',
  'America/Boa_Vista': 'America/Manaus',
  'America/Rio_Branco': 'America/Rio_Branco',
  'America/Porto_Acre': 'America/Rio_Branco',
  'Brazil/Acre': 'America/Rio_Branco',
  'America/Eirunepe': 'America/Rio_Branco',
};

/** Fuso da conta equivalente ao fuso IANA do aparelho; fora do Brasil (ou vazio), null. */
export const brazilZoneFrom = (iana: string | null | undefined): BrazilTimezone | null =>
  (iana && BROWSER_ZONES[iana]) || null;

/** O fuso do aparelho de quem está usando o app, se for um do Brasil. */
export function browserBrazilZone(): BrazilTimezone | null {
  try {
    return brazilZoneFrom(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** "Manaus", como aparece nas frases: "horário de Manaus". */
export const timezoneLabel = (zone: string | null | undefined): string =>
  TIMEZONE_OPTIONS.find((o) => o.value === zone)?.label ?? 'Brasília';

/**
 * " (horário de Manaus)" ao lado da agenda de alguém (ADR 48), só quando o fuso dele não é o de
 * quem vê (quem não escolheu está em Brasília); vazio quando é o mesmo.
 */
export const zoneNote = (
  zone: string | null | undefined,
  viewerZone: string | null | undefined,
): string =>
  zone && zone !== (viewerZone ?? DEFAULT_TIMEZONE) ? ` (horário de ${timezoneLabel(zone)})` : '';
