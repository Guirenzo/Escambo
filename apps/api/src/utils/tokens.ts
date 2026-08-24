import { createHash, randomBytes } from 'node:crypto';

/** Gera um refresh token opaco (não-JWT) de alta entropia. */
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * Hash determinístico (SHA-256) do refresh token.
 * Guardamos apenas o hash no banco — um vazamento da tabela não expõe tokens usáveis.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
