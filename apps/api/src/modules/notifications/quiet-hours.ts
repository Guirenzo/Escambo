import type { BrazilTimezone } from '@escambo/types';
import { startOfTodayIn } from '../../utils/timezone';

/**
 * "Não perturbe" nos avisos do navegador (ADR 54): a janela de silêncio da conta, em horas cheias
 * do fuso da própria conta (ADR 46). Só contas puras: quem decide o que fazer com o aviso é o
 * serviço de push.
 */

/** Janela de silêncio: de `start` (inclusive) a `end` (exclusive), horas de 0 a 23. */
export interface QuietWindow {
  start: number;
  end: number;
}

const isHour = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;

/**
 * A janela como a conta guarda: NULL nas duas colunas é desligado. Início igual ao fim não é uma
 * janela (seria "o dia inteiro" ou "nunca", e as duas leituras enganam), então também vale como
 * desligado — a validação da API nem deixa gravar assim.
 */
export function quietWindowOf(
  start: number | null | undefined,
  end: number | null | undefined,
): QuietWindow | null {
  if (!isHour(start) || !isHour(end) || start === end) return null;
  return { start, end };
}

/**
 * A hora local está dentro da janela? Semiaberta, como um horário de atendimento: das 22 às 7
 * silencia 22:00 até 06:59 e libera às 07:00. Uma janela que cruza a meia-noite (início maior que
 * o fim) é o caso comum, e é tratada pela mesma conta: dentro se está depois do início OU antes
 * do fim; uma janela diurna (13 às 14) é o caso simples: depois do início E antes do fim.
 */
export function inQuietWindow(hour: number, window: QuietWindow | null): boolean {
  if (!window) return false;
  const { start, end } = window;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Teto do que o serviço de push segura para aparelho offline: o que o provedor sempre usou. */
export const PUSH_TTL_MAX_SECONDS = 12 * 3600;
/** Piso: um aparelho num túnel às 21:55 não perde o aviso por causa da janela das 22h. */
export const PUSH_TTL_MIN_SECONDS = 15 * 60;

/**
 * Por quanto tempo o serviço de push pode segurar um aviso sem furar o silêncio: até o próximo
 * início da janela, preso entre 15 minutos e 12 horas. Sem janela, 12 horas. O serviço entrega
 * na hora se o aparelho está online; o TTL só evita que um aviso da tarde chegue de madrugada a
 * um aparelho que ficou offline — e, sim, um aviso que vence antes de o aparelho voltar se perde
 * no aparelho (a lista de notificações continua sendo o registro).
 */
export function pushTtlSeconds(
  zone: BrazilTimezone,
  window: QuietWindow | null,
  now: Date,
): number {
  if (!window) return PUSH_TTL_MAX_SECONDS;
  const today = startOfTodayIn(zone, now).getTime() + window.start * 3_600_000;
  const next = today > now.getTime() ? today : today + 86_400_000;
  const until = Math.ceil((next - now.getTime()) / 1000);
  return Math.min(PUSH_TTL_MAX_SECONDS, Math.max(PUSH_TTL_MIN_SECONDS, until));
}

/** "22:00 às 07:00", como a janela aparece nos textos. */
export const quietWindowLabel = (window: QuietWindow): string =>
  `${String(window.start).padStart(2, '0')}:00 às ${String(window.end).padStart(2, '0')}:00`;
