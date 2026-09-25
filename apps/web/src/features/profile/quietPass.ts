import type { QuietPassCategory } from '@escambo/types';

/**
 * O que pode sair durante o silêncio (ADR 56). Espelho de QUIET_PASS_CATEGORIES
 * (apps/api/src/modules/notifications/quiet-hours.ts): o Record obriga a escrever o texto de toda
 * categoria do tipo, e a ordem das chaves é a ordem na tela. Mudou lá, muda aqui e na Política.
 */
export const QUIET_PASS_TEXT: Record<
  QuietPassCategory,
  { label: string; hint: string; on: string; off: (end: string) => string; phrase: string }
> = {
  deadline: {
    label: 'Prazo vencido num trabalho que você entrega',
    hint: 'Sai na hora, com a hora-limite para agir antes da mediação automática, e vai ao serviço de push com prioridade alta. O resto espera.',
    on: 'Pronto: prazo vencido num trabalho que você entrega sai na hora, mesmo no silêncio.',
    off: (end) =>
      `Pronto: prazo vencido num trabalho que você entrega também espera, e vem primeiro no aviso das ${end}.`,
    phrase: 'prazo vencido num trabalho que você entrega',
  },
};

export const QUIET_PASS_ORDER = Object.keys(QUIET_PASS_TEXT) as QuietPassCategory[];

/** O que vem marcado quando quem entrega trabalho liga o silêncio e ainda não escolheu. */
export const QUIET_PASS_DEFAULT: readonly QuietPassCategory[] = ['deadline'];

/** "prazo vencido num trabalho que você entrega sai na hora" (ou "… e … saem"); null = nada. */
export function passPhrase(pass: readonly QuietPassCategory[]): string | null {
  const list = QUIET_PASS_ORDER.filter((c) => pass.includes(c)).map(
    (c) => QUIET_PASS_TEXT[c].phrase,
  );
  return list.length === 0
    ? null
    : `${list.join(' e ')} ${list.length === 1 ? 'sai' : 'saem'} na hora`;
}
