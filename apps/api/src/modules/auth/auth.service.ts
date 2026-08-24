import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ulid } from 'ulid';
import type { AuthResponse, PublicUser, RefreshResponse, UserRole } from '@escambo/types';
import { env } from '../../config/env';
import { HttpError } from '../../utils/http-error';
import { generateRefreshToken, hashToken } from '../../utils/tokens';
import { authRepository, type UserRow } from './auth.repository';
import { sessionRepository } from './session.repository';
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
  return { ulid: user.ulid, email: user.email, role: user.role as UserRole };
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

/** Regras de negócio de autenticação (RF-001 a RF-004, RNF-013). */
export const authService = {
  async register(input: RegisterInput): Promise<PublicUser> {
    const existing = await authRepository.findByEmail(input.email);
    if (existing) {
      throw new HttpError(409, 'E-mail já cadastrado', 'email_taken'); // RN-001
    }

    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS); // RNF-011
    const userUlid = ulid();

    await authRepository.create({
      ulid: userUlid,
      email: input.email,
      passwordHash,
      role: input.role,
    });

    return { ulid: userUlid, email: input.email, role: input.role };
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
