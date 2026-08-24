import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ulid } from 'ulid';
import type { AuthResponse, PublicUser, UserRole } from '@escambo/types';
import { env } from '../../config/env';
import { HttpError } from '../../utils/http-error';
import { authRepository } from './auth.repository';
import type { LoginInput, RegisterInput } from './auth.schema';

function signToken(payload: { sub: string; role: string }): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/** Regras de negócio de autenticação (RF-001 cadastro, RF-003 JWT). */
export const authService = {
  async register(input: RegisterInput): Promise<PublicUser> {
    const existing = await authRepository.findByEmail(input.email);
    if (existing) {
      // RN-001: e-mail único por conta
      throw new HttpError(409, 'E-mail já cadastrado', 'email_taken');
    }

    // RNF-011: bcrypt com salt rounds >= 12
    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS);
    const userUlid = ulid();

    await authRepository.create({
      ulid: userUlid,
      email: input.email,
      passwordHash,
      role: input.role,
    });

    return { ulid: userUlid, email: input.email, role: input.role };
  },

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await authRepository.findByEmail(input.email);
    if (!user || !user.password_hash) {
      throw new HttpError(401, 'Credenciais inválidas', 'invalid_credentials');
    }

    const ok = await bcrypt.compare(input.password, user.password_hash);
    if (!ok) {
      throw new HttpError(401, 'Credenciais inválidas', 'invalid_credentials');
    }

    const token = signToken({ sub: user.ulid, role: user.role });
    return {
      token,
      user: { ulid: user.ulid, email: user.email, role: user.role as UserRole },
    };
  },
};
