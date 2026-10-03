import { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Só o papel `admin` do token passa; qualquer outro é 403 antes de a rota rodar. */
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

  it('o papel é comparado exatamente: "Admin" ou "superadmin" não passam', async () => {
    await request(app).get('/api/admin/painel').set(bearer(7, 'Admin')).expect(403);
    await request(app).get('/api/admin/painel').set(bearer(7, 'superadmin')).expect(403);
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

  it('para o admin chama next() uma vez, sem erro', () => {
    const next = vi.fn();
    const req = { user: { sub: 'ulid-1', uid: 1, role: 'admin' } } as Request;
    requireAdmin(req, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});
