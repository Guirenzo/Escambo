import { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A consulta leve da exigência de 2FA no painel (ADR 66): a única do requireAdmin no banco.
vi.mock('../modules/auth/mfa.repository', () => ({ mfaRepository: { isEnabled: vi.fn() } }));

import { env } from '../config/env';
import { mfaRepository } from '../modules/auth/mfa.repository';
import { bearer, routerApp } from '../test-support/http';
import { HttpError } from '../utils/http-error';
import { authenticate } from './authenticate';
import { requireAdmin } from './require-admin';

const handler = vi.fn((_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Como nas rotas de admin: primeiro o login, depois o papel.
const router = Router();
router.get('/painel', authenticate, requireAdmin, handler);
const app = routerApp('/api/admin', router);

/** Só o papel atual `admin` passa; claims fora dos papéis válidos são recusadas antes da rota. */
describe('requireAdmin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('quem não é admin recebe 403 admin_only e a rota não roda', async () => {
    for (const role of ['client', 'freelancer', 'company']) {
      const res = await request(app).get('/api/admin/painel').set(bearer(7, role)).expect(403);
      expect(res.body).toEqual({
        error: 'admin_only',
        message: 'Acesso restrito a administradores',
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('claims com papel "Admin" ou "superadmin" são inválidas: 401 antes da checagem de admin', async () => {
    for (const role of ['Admin', 'superadmin']) {
      const res = await request(app).get('/api/admin/painel').set(bearer(7, role)).expect(401);
      expect(res.body.error).toBe('invalid_token');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('admin passa e a rota responde', async () => {
    const res = await request(app).get('/api/admin/painel').set(bearer(1, 'admin')).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sem login o 401 vem antes da checagem de papel', async () => {
    const res = await request(app).get('/api/admin/painel').expect(401);
    expect(res.body.error).toBe('missing_token');
    expect(handler).not.toHaveBeenCalled();
  });

  it('usado sem o authenticate antes (req.user ausente), barra em vez de deixar passar', () => {
    const next = vi.fn();
    let thrown: unknown;
    try {
      requireAdmin({} as Request, {} as Response, next);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ statusCode: 403, code: 'admin_only' });
    expect(next).not.toHaveBeenCalled();
  });

  it('sem ADMIN_MFA_REQUIRED, a 2FA do admin nem é consultada', async () => {
    await request(app).get('/api/admin/painel').set(bearer(1, 'admin')).expect(200);
    expect(mfaRepository.isEnabled).not.toHaveBeenCalled();
  });

  it('para o admin chama next() uma vez, sem erro', () => {
    const next = vi.fn();
    const req = { user: { sub: 'ulid-1', uid: 1, role: 'admin' } } as Request;
    requireAdmin(req, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});

/** ADMIN_MFA_REQUIRED (ADR 66): o painel só abre para o admin com a 2FA ativa. */
describe('requireAdmin com ADMIN_MFA_REQUIRED', () => {
  const isEnabled = vi.mocked(mfaRepository.isEnabled);
  beforeEach(() => {
    vi.clearAllMocks();
    env.ADMIN_MFA_REQUIRED = true;
  });
  afterEach(() => {
    env.ADMIN_MFA_REQUIRED = false;
  });

  it('admin sem a 2FA ativa: 403 mfa_required com o caminho para o perfil, e a rota não roda', async () => {
    isEnabled.mockResolvedValue(false);
    const res = await request(app).get('/api/admin/painel').set(bearer(1, 'admin')).expect(403);
    expect(res.body).toEqual({
      error: 'mfa_required',
      message: 'Ative a verificação em duas etapas no seu perfil para usar o painel.',
    });
    expect(isEnabled).toHaveBeenCalledWith(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('admin com a 2FA ativa passa', async () => {
    isEnabled.mockResolvedValue(true);
    await request(app).get('/api/admin/painel').set(bearer(1, 'admin')).expect(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('quem não é admin continua com 403 admin_only, sem consulta', async () => {
    const res = await request(app).get('/api/admin/painel').set(bearer(7, 'client')).expect(403);
    expect(res.body.error).toBe('admin_only');
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('a consulta falhou: o erro vai adiante (500), e o painel não abre sem saber', async () => {
    isEnabled.mockRejectedValue(new Error('banco fora'));
    const res = await request(app).get('/api/admin/painel').set(bearer(1, 'admin')).expect(500);
    expect(res.body.error).toBe('internal_error');
    expect(handler).not.toHaveBeenCalled();
  });
});
