import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { optionalUserId } from './authenticate';

const req = (authorization?: string): Request =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as Request;

const sign = (claims: Record<string, unknown>, options: jwt.SignOptions = { expiresIn: '5m' }) =>
  jwt.sign(claims, env.JWT_SECRET, options);

/** Quem abre uma rota pública (o detalhe do serviço): só identifica, nunca barra nem dá acesso. */
describe('optionalUserId', () => {
  it('token válido diz quem é', () => {
    expect(optionalUserId(req(`Bearer ${sign({ sub: 'ulid-7', uid: 7, role: 'client' })}`))).toBe(
      7,
    );
  });

  it('sem token, com outro esquema, inválido, vencido ou com claims tortas: anônimo', () => {
    const expired = sign({ sub: 'ulid-7', uid: 7, role: 'client' }, { expiresIn: -10 });
    const otherSecret = jwt.sign({ sub: 'ulid-7', uid: 7, role: 'client' }, 'outro-segredo-123456');
    const badClaims = sign({ sub: 'ulid-7', uid: 'sete', role: 'client' });
    for (const header of [
      undefined,
      'Basic dXNlcjpzZW5oYQ==',
      'Bearer nao-e-um-jwt',
      `Bearer ${expired}`,
      `Bearer ${otherSecret}`,
      `Bearer ${badClaims}`,
    ]) {
      expect(optionalUserId(req(header)), String(header)).toBeUndefined();
    }
  });
});
