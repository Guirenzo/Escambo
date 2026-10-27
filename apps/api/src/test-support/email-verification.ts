/**
 * Contas de mentira com o e-mail ainda não confirmado (RF-006), para as bordas HTTP unitárias: a
 * consulta da conta (account-access.setup.ts) devolve `email_verified_at` nulo para quem está aqui,
 * e confirmado para o resto. O teste que marca desmarca no fim.
 */
export const unverifiedEmails = new Set<number>();
