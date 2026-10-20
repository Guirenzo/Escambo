import { authRepository, type AccountLookupRow, type UserRow } from './auth.repository';
import { mfaRepository } from './mfa.repository';
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

  /** A conta pelo e-mail, para o atendimento do admin (ADR 66). */
  findAccountByEmail(email: string): Promise<AccountLookupRow | undefined> {
    return authRepository.findAccountByEmail(email);
  },

  /** A 2FA da conta está ativa? (a exigência do painel com ADMIN_MFA_REQUIRED, ADR 66) */
  isMfaEnabled(userId: number): Promise<boolean> {
    return mfaRepository.isEnabled(userId);
  },

  /** Apaga a 2FA da conta (o reset pelo atendimento). Devolve quantas linhas saíram. */
  deleteMfa(userId: number): Promise<number> {
    return mfaRepository.deleteForUser(userId);
  },
};
