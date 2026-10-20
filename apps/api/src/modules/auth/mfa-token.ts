import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

/**
 * O passe entre a senha e o segundo fator (ADR 66): o login com a senha certa numa conta com 2FA
 * devolve este token, e não a sessão. Vale 5 minutos e só serve para POST /auth/login/mfa.
 *
 * É assinado com uma chave DERIVADA do JWT_SECRET, e não com ele: assim o `authenticate` (que
 * confere com o JWT_SECRET) nunca o aceita como token de acesso, nem que alguém copie as claims.
 * E o token de acesso também não passa aqui, pelo mesmo motivo.
 */

export const MFA_TOKEN_TTL_SECONDS = 300;

const mfaKey = (): Buffer =>
  createHmac('sha256', env.JWT_SECRET).update('escambo:mfa-token:').digest();

export function signMfaToken(userUlid: string): string {
  return jwt.sign({ purpose: 'mfa' }, mfaKey(), {
    algorithm: 'HS256',
    subject: userUlid,
    expiresIn: MFA_TOKEN_TTL_SECONDS,
  });
}

/** O ulid da conta, se o token é um passe de 2FA nosso e ainda vale; senão, null. */
export function verifyMfaToken(token: string): string | null {
  try {
    const claims = jwt.verify(token, mfaKey(), { algorithms: ['HS256'] });
    if (
      typeof claims === 'object' &&
      claims.purpose === 'mfa' &&
      typeof claims.sub === 'string' &&
      claims.sub !== ''
    ) {
      return claims.sub;
    }
  } catch {
    // Vencido, adulterado ou assinado com outra chave: o mesmo "não vale" para quem chama.
  }
  return null;
}
