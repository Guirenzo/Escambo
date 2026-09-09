import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../config/blocklist';
import { env } from '../config/env';
import { authenticate } from './authenticate';

const token = (uid: number): string =>
  jwt.sign({ sub: `ulid-${uid}`, uid, role: 'client' }, env.JWT_SECRET, { expiresIn: '5m' });

const run = (authorization?: string): { req: Request; next: ReturnType<typeof vi.fn> } => {
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  const next = vi.fn();
  authenticate(req, {} as Response, next);
  return { req, next };
};

describe('authenticate + lista de bloqueio', () => {
  beforeEach(() => {
    blocklist.delete(7);
    blocklist.delete(8);
  });

  it('token válido de conta ativa passa e injeta req.user', () => {
    const { req, next } = run(`Bearer ${token(7)}`);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ uid: 7, role: 'client' });
  });

  it('conta bloqueada pela moderação toma 403 mesmo com token válido', () => {
    blocklist.add(8);
    expect(() => run(`Bearer ${token(8)}`)).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'account_blocked' }),
    );
  });

  it('reativar libera de novo', () => {
    blocklist.add(7);
    blocklist.delete(7);
    const { next } = run(`Bearer ${token(7)}`);
    expect(next).toHaveBeenCalledWith();
  });

  it('sem token ou token inválido continuam 401', () => {
    expect(() => run()).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(() => run('Bearer nada')).toThrow(expect.objectContaining({ statusCode: 401 }));
  });
});
