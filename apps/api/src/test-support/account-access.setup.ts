import { vi } from 'vitest';

/**
 * As bordas HTTP unitárias já fornecem identidade/papel pelo bearer fictício e
 * simulam moderação pela blocklist. Só a consulta de identidade atual é isolada
 * aqui; integração usa o config próprio e consulta users de verdade.
 */
vi.mock('../modules/auth/account-access.repository', async () => {
  const { blocklist } = await import('../config/blocklist');
  return {
    accountAccessRepository: {
      findCurrent: vi.fn(async (identity: { uid: number; sub: string; role: string }) => ({
        id: identity.uid,
        ulid: identity.sub,
        role: identity.role,
        status: blocklist.status(identity.uid) ?? 'active',
        deleted_at: null,
      })),
    },
  };
});
