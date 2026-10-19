import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../config/blocklist';
import { env } from '../config/env';
import { authenticate } from './authenticate';

const token = (uid: number): string =>
  jwt.sign({ sub: `ulid-${uid}`, uid, role: 'client' }, env.JWT_SECRET, { expiresIn: '5m' });

const run = async (authorization?: string, method = 'GET', path = '/api/contracts') => {
  const req = {
    headers: authorization ? { authorization } : {},
    method,
    originalUrl: path,
  } as unknown as Request;
  const res = { setHeader: vi.fn() };
  const next = vi.fn();
  await authenticate(req, res as unknown as Response, next);
  return { req, res, next };
};

describe('authenticate + lista de bloqueio', () => {
  beforeEach(() => {
    blocklist.delete(7);
    blocklist.delete(8);
  });

  it('token válido de conta ativa passa e injeta req.user atual', async () => {
    const { req, res, next } = await run(`Bearer ${token(7)}`);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ uid: 7, role: 'client', status: 'active' });
    expect(res.setHeader).toHaveBeenCalledWith('X-Account-Status', 'active');
  });

  it('conta banida toma 403 mesmo com token válido', async () => {
    blocklist.add(8);
    expect((await run(`Bearer ${token(8)}`)).next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: 'account_blocked' }),
    );
  });

  it('reativar libera escrita de novo', async () => {
    blocklist.add(7);
    blocklist.delete(7);
    const { next } = await run(`Bearer ${token(7)}`, 'POST');
    expect(next).toHaveBeenCalledWith();
  });

  it('sem token ou token inválido continuam 401', async () => {
    expect((await run()).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect((await run('Bearer nada')).next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
  it('suspenso consulta, mas não escreve negócios', async () => {
    blocklist.add(7, 'suspended');
    const read = await run(`Bearer ${token(7)}`);
    expect(read.next).toHaveBeenCalledWith();
    expect(read.req.user?.status).toBe('suspended');
    const write = await run(`Bearer ${token(7)}`, 'POST');
    expect(write.next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: 'account_suspended' }),
    );
    expect(write.res.setHeader).toHaveBeenCalledWith('X-Account-Status', 'suspended');
  });
  it('preserva pedidos do titular explicitamente permitidos', async () => {
    blocklist.add(7, 'suspended');
    expect(
      (await run(`Bearer ${token(7)}`, 'POST', '/api/lgpd/export-requests')).next,
    ).toHaveBeenCalledWith();
  });
});
