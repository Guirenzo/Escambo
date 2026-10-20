import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository } from './session.repository';

/**
 * Fachada do módulo auth para quem está fora dele (RNF-021): a conta é lida e a preferência de
 * e-mail gravada por aqui, e não pelo repository. Só repassa, com os mesmos argumentos, e não importa
 * nada além dos próprios repositories: é folha no grafo, então notificações, push e LGPD (que o
 * authService usa) podem chamá-la sem criar ciclo. A regra está em apps/api/eslint.boundaries.mjs.
 */
export const authFacade = {
  findById(id: number): Promise<UserRow | undefined> {
    return authRepository.findById(id);
  },

  findByUlid(ulid: string): Promise<UserRow | undefined> {
    return authRepository.findByUlid(ulid);
  },

  /** Frequência, hora do resumo, fuso e "não perturbe" (a tela de notificações grava aqui). */
  setEmailPreference(...args: Parameters<typeof authRepository.setEmailPreference>) {
    return authRepository.setEmailPreference(...args);
  },

  /** Encerra todas as sessões da pessoa (o banimento pelo admin). Devolve quantas fechou. */
  revokeAllSessions(userId: number): Promise<number> {
    return sessionRepository.revokeAllForUser(userId);
  },
};
