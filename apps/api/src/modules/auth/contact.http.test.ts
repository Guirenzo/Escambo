import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { authRoutes } from './auth.routes';

const { contact, limiter } = vi.hoisted(() => ({
  contact: {
    get: vi.fn(),
    requestEmailChange: vi.fn(),
    cancelEmailChange: vi.fn(),
    confirmEmailChange: vi.fn(),
    updatePhone: vi.fn(),
  },
  // No lugar do loginRateLimiter: deixa passar e registra por qual rota passou.
  limiter: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock('./contact.service', () => ({ contactService: contact }));
vi.mock('./auth.service', () => ({ authService: {} }));
vi.mock('../../middlewares/rate-limit', () => ({ loginRateLimiter: limiter }));

const app = routerApp('/api/auth', authRoutes);

const AGENT = 'vitest-agent/1.0';
const CTX = { ip: expect.stringMatching(/127\.0\.0\.1$/), userAgent: AGENT };
const CONTACT = {
  email: 'ana@escambo.test',
  emailVerified: true,
  phone: '+5547999991234',
  pendingEmail: null,
};
const LINK_TOKEN = 'a'.repeat(32);

/** Borda HTTP do contato da conta (RF-017): quem chama, o que a validação barra, o que chega ao service. */
describe('contato da conta: borda HTTP', () => {
  beforeEach(() => {
    limiter.mockClear();
    for (const fn of Object.values(contact)) fn.mockReset();
  });

  it('as rotas do titular exigem login; nada chega ao service sem token', async () => {
    for (const call of [
      request(app).get('/api/auth/contact'),
      request(app).put('/api/auth/phone').send({ phone: null }),
      request(app).post('/api/auth/change-email').send({}),
      request(app).delete('/api/auth/change-email'),
    ]) {
      const res = await call.expect(401);
      expect(res.body.error).toBe('missing_token');
    }
    for (const fn of Object.values(contact)) expect(fn).not.toHaveBeenCalled();
    expect(limiter).not.toHaveBeenCalled();
  });

  it('GET /contact devolve o contato do usuário do token', async () => {
    contact.get.mockResolvedValue(CONTACT);
    const res = await request(app).get('/api/auth/contact').set(bearer(7)).expect(200);
    expect(res.body).toEqual(CONTACT);
    expect(contact.get).toHaveBeenCalledWith(7);
  });

  describe('PUT /phone', () => {
    it('chega ao service já em E.164; null e vazio apagam', async () => {
      contact.updatePhone.mockResolvedValue(CONTACT);
      const res = await request(app)
        .put('/api/auth/phone')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        .send({ phone: '(47) 99999-1234', userId: 99 })
        .expect(200);
      expect(res.body).toEqual(CONTACT);
      expect(contact.updatePhone).toHaveBeenCalledWith(7, '+5547999991234', CTX);

      await request(app).put('/api/auth/phone').set(bearer(7)).send({ phone: '' }).expect(200);
      expect(contact.updatePhone).toHaveBeenLastCalledWith(7, null, expect.anything());
    });

    it('número inválido é 422 com a mensagem para a tela, e nada é gravado', async () => {
      const res = await request(app)
        .put('/api/auth/phone')
        .set(bearer(7))
        .send({ phone: '+1 415 555 0100' })
        .expect(422);
      expect(res.body.details.phone).toEqual([
        'Telefone inválido: use um número do Brasil com DDD, como (47) 99999-1234',
      ]);
      expect(contact.updatePhone).not.toHaveBeenCalled();
    });
  });

  describe('POST /change-email', () => {
    const valid = { currentPassword: 'senha-atual-123', newEmail: '  Nova@Escambo.TEST ' };

    it('202 com o pedido pendente; o endereço vai sem espaços e em minúsculas; passa pelo limite do login', async () => {
      const pending = { email: 'nova@escambo.test', expiresAt: '2026-10-20T12:00:00.000Z' };
      contact.requestEmailChange.mockResolvedValue(pending);

      const res = await request(app)
        .post('/api/auth/change-email')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        .send({ ...valid, userId: 99 })
        .expect(202);

      expect(res.body).toEqual(pending);
      expect(contact.requestEmailChange).toHaveBeenCalledWith(
        7,
        { currentPassword: 'senha-atual-123', newEmail: 'nova@escambo.test' },
        CTX,
      );
      expect(limiter).toHaveBeenCalledTimes(1);
    });

    it('e-mail inválido ou sem senha: 422 sem chegar ao service', async () => {
      const res = await request(app)
        .post('/api/auth/change-email')
        .set(bearer(7))
        .send({ currentPassword: '', newEmail: 'nao-e-email' })
        .expect(422);
      expect(res.body.details).toEqual({
        currentPassword: ['Informe a senha atual'],
        newEmail: ['E-mail inválido'],
      });
      expect(contact.requestEmailChange).not.toHaveBeenCalled();
    });

    it('os erros do service saem com o código e a mensagem', async () => {
      contact.requestEmailChange.mockRejectedValue(
        new HttpError(400, 'Senha atual incorreta', 'wrong_password'),
      );
      const res = await request(app)
        .post('/api/auth/change-email')
        .set(bearer(7))
        .send(valid)
        .expect(400);
      expect(res.body).toEqual({ error: 'wrong_password', message: 'Senha atual incorreta' });
    });
  });

  it('DELETE /change-email desiste do pedido do usuário do token (204)', async () => {
    contact.cancelEmailChange.mockResolvedValue(undefined);
    await request(app)
      .delete('/api/auth/change-email')
      .set(bearer(7))
      .set('User-Agent', AGENT)
      .expect(204);
    expect(contact.cancelEmailChange).toHaveBeenCalledWith(7, CTX);
  });

  describe('POST /confirm-email-change', () => {
    it('é pública: sem token de acesso, o service recebe quem pediu como desconhecido', async () => {
      contact.confirmEmailChange.mockResolvedValue({ email: 'nova@escambo.test', session: null });
      const res = await request(app)
        .post('/api/auth/confirm-email-change')
        .set('User-Agent', AGENT)
        .send({ token: LINK_TOKEN })
        .expect(200);
      expect(res.body).toEqual({ email: 'nova@escambo.test', session: null });
      expect(contact.confirmEmailChange).toHaveBeenCalledWith(LINK_TOKEN, CTX, undefined);
      expect(limiter).toHaveBeenCalledTimes(1);
    });

    it('com o token de acesso, o service sabe de quem é a aba; token inválido vale como anônimo', async () => {
      contact.confirmEmailChange.mockResolvedValue({ email: 'nova@escambo.test', session: null });
      await request(app)
        .post('/api/auth/confirm-email-change')
        .set(bearer(7))
        .send({ token: LINK_TOKEN })
        .expect(200);
      expect(contact.confirmEmailChange).toHaveBeenLastCalledWith(LINK_TOKEN, expect.anything(), 7);
      await request(app)
        .post('/api/auth/confirm-email-change')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .send({ token: LINK_TOKEN })
        .expect(200);
      expect(contact.confirmEmailChange).toHaveBeenLastCalledWith(
        LINK_TOKEN,
        expect.anything(),
        undefined,
      );
    });

    it('token curto ou ausente é 422; link vencido sai como 400 invalid_token', async () => {
      await request(app)
        .post('/api/auth/confirm-email-change')
        .send({ token: 'curto' })
        .expect(422);
      await request(app).post('/api/auth/confirm-email-change').send({}).expect(422);
      expect(contact.confirmEmailChange).not.toHaveBeenCalled();

      contact.confirmEmailChange.mockRejectedValue(
        new HttpError(400, 'Link inválido ou vencido', 'invalid_token'),
      );
      const res = await request(app)
        .post('/api/auth/confirm-email-change')
        .send({ token: LINK_TOKEN })
        .expect(400);
      expect(res.body.error).toBe('invalid_token');
    });
  });

  describe('conta suspensa (RN-007)', () => {
    afterEach(() => blocklist.delete(7));

    it('consulta o contato e desiste da troca, mas não pede troca nem muda o telefone', async () => {
      blocklist.add(7, 'suspended');
      contact.get.mockResolvedValue(CONTACT);
      contact.cancelEmailChange.mockResolvedValue(undefined);

      await request(app).get('/api/auth/contact').set(bearer(7)).expect(200);
      await request(app).delete('/api/auth/change-email').set(bearer(7)).expect(204);
      for (const call of [
        request(app)
          .post('/api/auth/change-email')
          .send({ currentPassword: 'x', newEmail: 'nova@escambo.test' }),
        request(app).put('/api/auth/phone').send({ phone: '47999991234' }),
      ]) {
        const res = await call.set(bearer(7)).expect(403);
        expect(res.body.error).toBe('account_suspended');
      }
      expect(contact.requestEmailChange).not.toHaveBeenCalled();
      expect(contact.updatePhone).not.toHaveBeenCalled();
      expect(limiter).not.toHaveBeenCalled();
    });
  });
});
