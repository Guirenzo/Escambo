import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ulid } from 'ulid';
import type { AuthResponse, PublicUser, RefreshResponse, UserRole } from '@escambo/types';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { generateRefreshToken, hashToken } from '../../utils/tokens';
import { mailService } from '../mail/mail.service';
import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository } from './session.repository';
import { tokensRepository } from './tokens.repository';
import type { LoginInput, RegisterInput } from './auth.schema';

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

function signAccessToken(user: { id: number; ulid: string; role: string }): string {
  return jwt.sign({ sub: user.ulid, uid: user.id, role: user.role }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

function toPublic(user: UserRow): PublicUser {
  return {
    id: user.id,
    ulid: user.ulid,
    email: user.email,
    role: user.role as UserRole,
    emailVerified: user.email_verified_at != null,
  };
}

const appLink = (path: string): string => `${env.APP_URL.replace(/\/$/, '')}${path}`;

/** Gera um token de uso único, guarda só o hash e devolve o valor para ir no link. */
async function issueOneTimeToken(
  purpose: 'verify_email' | 'password_reset',
  userId: number,
  ttlMs: number,
): Promise<string> {
  await tokensRepository.invalidateOpen(purpose, userId);
  const token = generateRefreshToken();
  await tokensRepository.create(purpose, userId, hashToken(token), new Date(Date.now() + ttlMs));
  return token;
}

/** E-mail de boas-vindas com o link de confirmação (melhor esforço). */
async function sendVerification(user: { id: number; email: string }): Promise<void> {
  if (!mailService.enabled()) return;
  const token = await issueOneTimeToken(
    'verify_email',
    user.id,
    env.EMAIL_VERIFY_TTL_HOURS * 3_600_000,
  );
  await mailService.send({
    userId: user.id,
    to: user.email,
    template: 'verify_email',
    vars: {
      link: appLink(`/verificar-email?token=${token}`),
      validity: `${env.EMAIL_VERIFY_TTL_HOURS} horas`,
    },
  });
}

/** Emite um novo par (access token JWT + refresh token opaco) e persiste a sessão. */
async function issueSession(user: UserRow, ctx: SessionContext): Promise<RefreshResponse> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

  await sessionRepository.create({
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return { accessToken: signAccessToken(user), refreshToken };
}

/**
 * E-mails com poderes de admin (env ADMIN_EMAILS, separados por vírgula). Entradas que começam
 * com "@" valem para o domínio inteiro (ex.: "@admin.escambo.test").
 */
export function isAdminEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return env.ADMIN_EMAILS.split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => (entry.startsWith('@') ? e.endsWith(entry) : e === entry));
}

/** Conta suspensa/banida não entra nem renova sessão (RN-007). */
function assertActive(user: { status: string; deleted_at?: Date | null }): void {
  if (user.deleted_at) {
    throw new HttpError(403, 'Esta conta foi excluída a pedido do titular.', 'account_deleted');
  }
  if (user.status === 'suspended') {
    throw new HttpError(403, 'Conta suspensa. Fale com o suporte.', 'account_suspended');
  }
  if (user.status === 'banned') {
    throw new HttpError(403, 'Conta banida. Fale com o suporte.', 'account_banned');
  }
}

/** Regras de negócio de autenticação (RF-001 a RF-004, RNF-013). */
export const authService = {
  async register(input: RegisterInput): Promise<PublicUser> {
    const existing = await authRepository.findByEmail(input.email);
    if (existing) {
      throw new HttpError(409, 'E-mail já cadastrado', 'email_taken'); // RN-001
    }

    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS); // RNF-011
    const userUlid = ulid();

    // Lista de admins (ADMIN_EMAILS) tem precedência sobre o papel pedido no cadastro.
    const role: UserRole = isAdminEmail(input.email) ? 'admin' : input.role;
    const id = await authRepository.create({
      ulid: userUlid,
      email: input.email,
      passwordHash,
      role,
    });

    // Boas-vindas + confirmação de e-mail. Falha no e-mail não derruba o cadastro.
    try {
      await sendVerification({ id, email: input.email });
    } catch (err) {
      logger.warn({ err, userId: id }, 'e-mail de confirmação não enviado');
    }

    return { id, ulid: userUlid, email: input.email, role, emailVerified: false };
  },

  /** Confirma o e-mail pelo token do link (uso único, com validade). */
  async verifyEmail(token: string): Promise<PublicUser> {
    const userId = await tokensRepository.consume('verify_email', hashToken(token));
    if (!userId) throw new HttpError(400, 'Link inválido ou vencido', 'invalid_token');
    await authRepository.markEmailVerified(userId);
    const user = await authRepository.findById(userId);
    if (!user) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    return toPublic(user);
  },

  /** Reenvia o link de confirmação (409 se já confirmado). */
  async resendVerification(userId: number): Promise<void> {
    const user = await authRepository.findById(userId);
    if (!user) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    if (user.email_verified_at) {
      throw new HttpError(409, 'Este e-mail já foi confirmado', 'already_verified');
    }
    await sendVerification(user);
  },

  /**
   * "Esqueci minha senha": sempre responde igual (sem revelar se o e-mail existe). Se existir
   * uma conta ativa, envia o link de redefinição com validade curta.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await authRepository.findByEmail(email);
    if (!user || user.deleted_at || user.status === 'banned') return;
    if (!mailService.enabled()) return;
    const token = await issueOneTimeToken(
      'password_reset',
      user.id,
      env.PASSWORD_RESET_TTL_MINUTES * 60_000,
    );
    await mailService.send({
      userId: user.id,
      to: user.email,
      template: 'password_reset',
      vars: {
        link: appLink(`/redefinir-senha?token=${token}`),
        validity: `${env.PASSWORD_RESET_TTL_MINUTES} minutos`,
      },
    });
  },

  /** Define a nova senha pelo token (uso único) e encerra todas as sessões abertas. */
  async resetPassword(token: string, password: string): Promise<void> {
    const userId = await tokensRepository.consume('password_reset', hashToken(token));
    if (!userId) throw new HttpError(400, 'Link inválido ou vencido', 'invalid_token');
    const passwordHash = await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);
    await authRepository.updatePassword(userId, passwordHash);
    await authRepository.markEmailVerified(userId); // quem redefine provou controlar o e-mail
    await sessionRepository.revokeAllForUser(userId);
  },

  async login(input: LoginInput, ctx: SessionContext = {}): Promise<AuthResponse> {
    const user = await authRepository.findByEmail(input.email);
    if (!user || !user.password_hash) {
      throw new HttpError(401, 'Credenciais inválidas', 'invalid_credentials');
    }

    const ok = await bcrypt.compare(input.password, user.password_hash);
    if (!ok) {
      throw new HttpError(401, 'Credenciais inválidas', 'invalid_credentials');
    }

    assertActive(user);

    // Promoção a admin por ADMIN_EMAILS vale também para contas já existentes.
    if (user.role !== 'admin' && isAdminEmail(user.email)) {
      await authRepository.updateRole(user.id, 'admin');
      user.role = 'admin';
    }

    const tokens = await issueSession(user, ctx);
    return { ...tokens, user: toPublic(user) };
  },

  /** Rotação de refresh token: valida, revoga o antigo e emite um novo par. */
  async refresh(refreshToken: string, ctx: SessionContext = {}): Promise<RefreshResponse> {
    const tokenHash = hashToken(refreshToken);
    const session = await sessionRepository.findValidByHash(tokenHash);
    if (!session) {
      throw new HttpError(401, 'Refresh token inválido ou expirado', 'invalid_refresh');
    }

    const user = await authRepository.findById(session.user_id);
    if (!user) {
      throw new HttpError(401, 'Refresh token inválido ou expirado', 'invalid_refresh');
    }
    assertActive(user);

    await sessionRepository.revokeByHash(tokenHash); // rotação
    return issueSession(user, ctx);
  },

  async logout(refreshToken: string): Promise<void> {
    await sessionRepository.revokeByHash(hashToken(refreshToken));
  },

  /** Encerra todas as sessões do usuário (RN-008). */
  async logoutAll(userUlid: string): Promise<number> {
    const user = await authRepository.findByUlid(userUlid);
    if (!user) {
      throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    }
    return sessionRepository.revokeAllForUser(user.id);
  },

  async getByUlid(userUlid: string): Promise<PublicUser> {
    const user = await authRepository.findByUlid(userUlid);
    if (!user) {
      throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    }
    return toPublic(user);
  },
};
