import type { UserRole, UserStatus } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { logger } from '../../config/logger';
import { accountAccessRepository, type AccessIdentity } from './account-access.repository';

const ROLES: readonly string[] = ['client', 'freelancer', 'company', 'admin'];
const STATUSES: readonly string[] = ['active', 'pending_verification', 'suspended', 'banned'];

export interface CurrentAccount extends AccessIdentity {
  role: UserRole;
  status: UserStatus;
}

export function validateAccessIdentity(payload: unknown): AccessIdentity {
  const claims = payload as Partial<AccessIdentity> | null;
  if (
    !claims ||
    typeof claims.uid !== 'number' ||
    !Number.isSafeInteger(claims.uid) ||
    claims.uid <= 0 ||
    typeof claims.sub !== 'string' ||
    !claims.sub.trim() ||
    typeof claims.role !== 'string' ||
    !ROLES.includes(claims.role)
  ) {
    throw new HttpError(401, 'Token inválido ou expirado', 'invalid_token');
  }
  return { uid: claims.uid, sub: claims.sub, role: claims.role };
}

/** Uma consulta atual por request/evento; cache ou JWT não concedem autoridade de status/papel. */
export async function currentAccount(identity: AccessIdentity): Promise<CurrentAccount> {
  const row = await accountAccessRepository.findCurrent(identity).catch((err: unknown) => {
    logger.warn({ err, userId: identity.uid }, 'consulta do acesso da conta falhou');
    throw new HttpError(
      503,
      'Não foi possível conferir o acesso da conta.',
      'account_access_unavailable',
    );
  });
  if (!row) throw new HttpError(401, 'Token inválido ou expirado', 'invalid_token');
  if (row.deleted_at) {
    throw new HttpError(403, 'Esta conta foi excluída a pedido do titular.', 'account_deleted');
  }
  if (!STATUSES.includes(row.status) || !ROLES.includes(row.role)) {
    throw new HttpError(
      503,
      'Não foi possível conferir o acesso da conta.',
      'account_access_unavailable',
    );
  }
  if (row.status === 'banned') {
    throw new HttpError(403, 'Conta banida. Fale com o suporte.', 'account_blocked');
  }
  return { uid: row.id, sub: row.ulid, role: row.role, status: row.status };
}

export function assertBusinessWrite(account: CurrentAccount): void {
  if (account.status === 'suspended') {
    throw new HttpError(
      403,
      'Conta suspensa: acesso somente para consulta. Esta ação está bloqueada.',
      'account_suspended',
    );
  }
}

/** Exceções do próprio titular: suporte, privacidade, segurança e recurso de moderação. */
export function suspendedRequestAllowed(method: string, originalUrl: string): boolean {
  const path = originalUrl.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
  if (/^\/api\/admin(?:\/|$)/.test(path)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'POST') {
    return (
      [
        '/api/auth/logout-all',
        '/api/lgpd/consents',
        '/api/lgpd/deletion-requests',
        '/api/lgpd/export-requests',
        '/api/support/tickets',
      ].includes(path) ||
      /^\/api\/moderation\/removals\/\d+\/appeal$/.test(path) ||
      /^\/api\/profiles\/me\/dropouts\/\d+\/appeal$/.test(path) ||
      /^\/api\/support\/tickets\/\d+\/(messages|close)$/.test(path)
    );
  }
  return method === 'DELETE' && path === '/api/notifications/push';
}
