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

/** "Manaus", como aparece nas frases: "horário de Manaus". */
export const timezoneLabel = (zone: string | null | undefined): string =>
  TIMEZONE_OPTIONS.find((o) => o.value === zone)?.label ?? 'Brasília';
