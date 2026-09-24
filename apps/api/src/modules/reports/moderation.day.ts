import { DEFAULT_TIMEZONE, localParts, startOfTodayIn } from '../../utils/timezone';

/**
 * O dia da moderação é o de Brasília (ADR 50): relatório de operação da plataforma, não dado de
 * uma pessoa. Contas puras compartilhadas pelo painel, pelo CSV e pelo relatório diário.
 */

export const DAY_MS = 86_400_000;

/**
 * Dia ('AAAA-MM-DD') de um instante em Brasília. Usa o fuso IANA, que é -03:00 fixo desde 2019
 * (o Brasil não tem mais horário de verão): o mesmo dia que o banco calcula com CONVERT_TZ.
 */
export function dayKey(at: Date): string {
  const p = localParts(DEFAULT_TIMEZONE, at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Meia-noite de hoje em Brasília, como instante UTC. */
export const startOfTodayBrt = (now: Date): Date => startOfTodayIn(DEFAULT_TIMEZONE, now);

/** "07:30": só a hora em Brasília, para dizer "a meta foi alterada hoje às 07:30". */
export function clockBrt(at: Date): string {
  const p = localParts(DEFAULT_TIMEZONE, at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** "DD/MM" de um dia 'AAAA-MM-DD'. */
export const dayMonth = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
