import { vi } from 'vitest';

/**
 * As bordas HTTP unitárias já fornecem identidade/papel pelo bearer fictício e
 * simulam moderação pela blocklist. Só a consulta de identidade atual é isolada
 * aqui; integração usa o config próprio e consulta users de verdade. O e-mail
 * vem confirmado, menos o das contas em `unverifiedEmails` (RF-006).
 */
vi.mock('../modules/auth/account-access.repository', async () => {
  const { blocklist } = await import('../config/blocklist');
  const { unverifiedEmails } = await import('./email-verification');
  return {
    accountAccessRepository: {
      findCurrent: vi.fn(async (identity: { uid: number; sub: string; role: string }) => ({
        id: identity.uid,
        ulid: identity.sub,
        role: identity.role,
        status: blocklist.status(identity.uid) ?? 'active',
        deleted_at: null,
        email_verified_at: unverifiedEmails.has(identity.uid) ? null : new Date(0),
      })),
    },
  };
});
