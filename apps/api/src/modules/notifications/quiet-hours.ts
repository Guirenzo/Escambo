import type { BrazilTimezone, QuietPassCategory } from '@escambo/types';
import { hourIn, startOfTodayIn } from '../../utils/timezone';

/**
 * "Não perturbe" nos avisos do navegador (ADR 54): a janela de silêncio da conta, em horas cheias
 * do fuso da própria conta (ADR 46), e o que a pessoa deixa sair durante ela (ADR 56). Só contas
 * puras: quem decide o que fazer com o aviso é o serviço de push.
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

/**
 * Lista fechada do que pode sair no silêncio (ADR 56). Espelho do SET da migration 0026 (a
 * integração compara com o information_schema) e do Record de textos da tela. Categoria nova
 * exige ADR, versão da Política de Privacidade e membro novo NO FIM do SET.
 */
export const QUIET_PASS_CATEGORIES = ['deadline'] as const satisfies readonly QuietPassCategory[];

/** O SET do banco como lista canônica: NULL = nunca escolheu; '' = nada; desconhecido some. */
export function quietPassOf(raw: string | null | undefined): QuietPassCategory[] | null {
  if (raw == null) return null;
  const parts = raw.split(',');
  return QUIET_PASS_CATEGORIES.filter((c) => parts.includes(c));
}

export type PushTiming = { hold: true } | { hold: false; ttlSeconds: number; breaksQuiet: boolean };

/**
 * A decisão do push no instante do evento (ADR 54 e 56). Dentro da janela só sai o que tem
 * categoria E foi liberado pela pessoa; o resto fica retido para o resumo. O liberado pode chegar
 * durante o silêncio por escolha dela, então o TTL dele não acaba no início da janela (fecha o piso
 * de 15 min de um aviso das 21:50).
 */
export function pushTiming(p: {
  zone: BrazilTimezone;
  window: QuietWindow | null;
  now: Date;
  category: QuietPassCategory | null;
  allowed: readonly QuietPassCategory[];
}): PushTiming {
  const allowed = p.category !== null && p.allowed.includes(p.category);
  const quiet = inQuietWindow(hourIn(p.zone, p.now), p.window);
  if (quiet && !allowed) return { hold: true };
  return {
    hold: false,
    ttlSeconds: allowed ? PUSH_TTL_MAX_SECONDS : pushTtlSeconds(p.zone, p.window, p.now),
    breaksQuiet: quiet, // aqui, quiet implica allowed
  };
}

/** "22:00 às 07:00", como a janela aparece nos textos. */
export const quietWindowLabel = (window: QuietWindow): string =>
  `${String(window.start).padStart(2, '0')}:00 às ${String(window.end).padStart(2, '0')}:00`;
