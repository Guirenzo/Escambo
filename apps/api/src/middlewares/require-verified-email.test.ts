import { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../config/blocklist';
import { EMAIL_NOT_VERIFIED_MESSAGE } from '../modules/auth/account-access';
import { unverifiedEmails } from '../test-support/email-verification';
import { bearer, routerApp } from '../test-support/http';
import { authenticate } from './authenticate';
import { requireVerifiedEmail, requireVerifiedEmailWhen } from './require-verified-email';

const handler = vi.fn((_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Como nas rotas das ações críticas: primeiro o login (que lê a conta), depois o e-mail.
const router = Router();
router.post('/contratar', authenticate, requireVerifiedEmail, handler);
router.patch(
  '/servico',
  authenticate,
  requireVerifiedEmailWhen((req) => (req.body as { isActive?: unknown })?.isActive === true),
  handler,
);
// Sem o authenticate antes (erro de montagem): recusa, e a ação não roda.
router.post('/sem-login', requireVerifiedEmail, handler);
const app = routerApp('/api', router);

const NOT_VERIFIED = { error: 'email_not_verified', message: EMAIL_NOT_VERIFIED_MESSAGE };

afterEach(() => {
  unverifiedEmails.clear();
  blocklist.delete(7);
  vi.clearAllMocks();
});

/** Ações críticas exigem e-mail confirmado (RF-006, RN-004). */
describe('requireVerifiedEmail', () => {
  it('sem e-mail confirmado: 403 email_not_verified e a rota não roda', async () => {
    unverifiedEmails.add(7);
    const res = await request(app).post('/api/contratar').set(bearer(7)).expect(403);
    expect(res.body).toEqual(NOT_VERIFIED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('com e-mail confirmado: segue para a rota', async () => {
    await request(app).post('/api/contratar').set(bearer(7)).expect(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('vale para qualquer papel, inclusive o admin agindo como usuário', async () => {
    unverifiedEmails.add(7);
    for (const role of ['client', 'freelancer', 'admin']) {
      const res = await request(app).post('/api/contratar').set(bearer(7, role)).expect(403);
      expect(res.body.error).toBe('email_not_verified');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('sem login, o authenticate responde antes (401)', async () => {
    unverifiedEmails.add(7);
    await request(app).post('/api/contratar').expect(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('conta suspensa recebe a suspensão, que vem antes do e-mail', async () => {
    unverifiedEmails.add(7);
    blocklist.add(7, 'suspended');
    const res = await request(app).post('/api/contratar').set(bearer(7)).expect(403);
    expect(res.body.error).toBe('account_suspended');
  });

  it('montada sem o authenticate, recusa: a ação crítica nunca roda sem a checagem', async () => {
    const res = await request(app).post('/api/sem-login').expect(403);
    expect(res.body).toEqual(NOT_VERIFIED);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('requireVerifiedEmailWhen', () => {
  it('só exige quando o pedido é a parte crítica (deixar o serviço no ar)', async () => {
    unverifiedEmails.add(7);
    const res = await request(app)
      .patch('/api/servico')
      .set(bearer(7))
      .send({ isActive: true })
      .expect(403);
    expect(res.body).toEqual(NOT_VERIFIED);
    expect(handler).not.toHaveBeenCalled();

    // Pausar e editar o texto não publicam nada.
    await request(app).patch('/api/servico').set(bearer(7)).send({ isActive: false }).expect(200);
    await request(app).patch('/api/servico').set(bearer(7)).send({ title: 'Novo' }).expect(200);
    await request(app).patch('/api/servico').set(bearer(7)).expect(200);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('com e-mail confirmado, reativar passa', async () => {
    await request(app).patch('/api/servico').set(bearer(7)).send({ isActive: true }).expect(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
