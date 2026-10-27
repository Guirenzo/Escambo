import type { UserRole, UserStatus } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { logger } from '../../config/logger';
import { accountAccessRepository, type AccessIdentity } from './account-access.repository';

const ROLES: readonly string[] = ['client', 'freelancer', 'company', 'admin'];
const STATUSES: readonly string[] = ['active', 'pending_verification', 'suspended', 'banned'];

export interface CurrentAccount extends AccessIdentity {
  role: UserRole;
  status: UserStatus;
  /** O e-mail da conta está confirmado (RF-006, RN-004). */
  emailVerified: boolean;
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
  return {
    uid: row.id,
    sub: row.ulid,
    role: row.role,
    status: row.status,
    emailVerified: row.email_verified_at != null,
  };
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

/** A mesma frase para toda ação recusada por e-mail não confirmado (RF-006). */
export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Confirme seu e-mail para continuar: abra o link que enviamos ou peça um novo.';

/**
 * Ações críticas exigem e-mail confirmado (RF-006, RN-004): contratar, publicar serviço, depositar
 * ou pagar, propor ou aceitar troca, impulsionar e sacar. Vale para qualquer papel; o admin só
 * passa sem ela quando age como equipe, em rotas que não usam esta checagem. O resto (navegar,
 * perfil, responder ao que já existe, suporte, LGPD, segurança da conta) continua livre.
 */
export function assertEmailVerified(account: Pick<CurrentAccount, 'emailVerified'>): void {
  if (!account.emailVerified) {
    throw new HttpError(403, EMAIL_NOT_VERIFIED_MESSAGE, 'email_not_verified');
  }
}

/**
 * Exceções do próprio titular: suporte, privacidade, segurança, recurso de moderação e o registro
 * de leitura do chat.
 */
export function suspendedRequestAllowed(method: string, originalUrl: string): boolean {
  const path = originalUrl.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
  if (/^\/api\/admin(?:\/|$)/.test(path)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'POST') {
    return (
      [
        '/api/auth/logout-all',
        // Trocar a senha é segurança da conta (RF-017): vale também durante a suspensão.
        '/api/auth/change-password',
        // A verificação em duas etapas também (ADR 66): ligar, desligar e trocar os códigos.
        '/api/auth/mfa/setup',
        '/api/auth/mfa/enable',
        '/api/auth/mfa/disable',
        '/api/auth/mfa/recovery-codes',
        '/api/lgpd/consents',
        '/api/lgpd/deletion-requests',
        '/api/lgpd/export-requests',
        '/api/support/tickets',
      ].includes(path) ||
      /^\/api\/moderation\/removals\/\d+\/appeal$/.test(path) ||
      /^\/api\/profiles\/me\/dropouts\/\d+\/appeal$/.test(path) ||
      // Marcar como lida registra a consulta (RF-059): não cria conteúdo, conversa nem efeito de
      // negócio, e bloquear deixaria "Enviada" para quem mandou uma mensagem que já foi lida.
      /^\/api\/messaging\/contracts\/\d+\/read$/.test(path) ||
      /^\/api\/support\/tickets\/\d+\/(messages|close)$/.test(path)
    );
  }
  if (method === 'DELETE') {
    return (
      path === '/api/notifications/push' ||
      // Desistir de uma troca de e-mail pendente só protege a conta (RF-017); pedir uma troca, não.
      path === '/api/auth/change-email'
    );
  }
  return false;
}
