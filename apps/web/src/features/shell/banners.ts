import type { BrazilTimezone, Consent, PublicUser } from '@escambo/types';
import { legalAckPending } from '../legal/version';

/** Qual faixa o topo do app mostra: uma por vez, para não empilhar três num celular. */
export type Banner = 'legal' | 'timezone' | 'verify-email' | null;

/**
 * Prioridade: a atualização da Política (pede uma resposta e registra), depois a sugestão de fuso
 * (também some com um clique), depois o lembrete de e-mail não confirmado, que volta a aparecer
 * assim que os outros forem respondidos. Sem consentimentos carregados (ou com erro), a faixa
 * legal não aparece nesta carga: melhor calar do que pedir de novo a quem já respondeu.
 */
export function pickBanner(
  user: PublicUser | null,
  consents: readonly Consent[] | undefined,
  detected: BrazilTimezone | null,
): Banner {
  if (!user) return null;
  if (consents && legalAckPending(consents, 'privacidade')) return 'legal';
  if (!user.timezoneChosen && detected && detected !== user.timezone) return 'timezone';
  if (!user.emailVerified) return 'verify-email';
  return null;
}
