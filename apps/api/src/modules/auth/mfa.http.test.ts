import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { authRoutes } from './auth.routes';

const { auth, mfa, limiter } = vi.hoisted(() => ({
  auth: { loginMfa: vi.fn() },
  mfa: {
    status: vi.fn(),
    setup: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
  },
  // No lugar do loginRateLimiter: deixa passar e registra por qual rota passou.
  limiter: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock('./auth.service', () => ({ authService: auth }));
vi.mock('./mfa.service', () => ({ mfaService: mfa }));
vi.mock('../../middlewares/rate-limit', () => ({ loginRateLimiter: limiter }));

const app = routerApp('/api/auth', authRoutes);
const AGENT = 'vitest-agent/1.0';
const CTX = { ip: expect.stringMatching(/127\.0\.0\.1$/), userAgent: AGENT };
const TOKENS = { accessToken: 'jwt.de.acesso', refreshToken: 'refresh-opaco' };

beforeEach(() => {
  limiter.mockClear();
  for (const fn of [...Object.values(auth), ...Object.values(mfa)]) fn.mockReset();
});

/** Verificação em duas etapas (ADR 66): a borda HTTP do login e das rotas da própria conta. */
describe('POST /api/auth/login/mfa', () => {
  it('é pública, passa pelo limite do login e entrega ao service o passe, o código e a origem', async () => {
    const session = { ...TOKENS, user: { id: 7 } };
    auth.loginMfa.mockResolvedValue(session);

    const res = await request(app)
      .post('/api/auth/login/mfa')
      .set('User-Agent', AGENT)
      .send({ mfaToken: 'passe', code: ' 123 456 ', extra: 'x' })
      .expect(200);

    expect(res.body).toEqual(session);
    expect(auth.loginMfa).toHaveBeenCalledWith({ mfaToken: 'passe', code: '123 456' }, CTX);
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  it('sem passe ou sem código: 422 e o service não é chamado', async () => {
    for (const body of [
      {},
      { mfaToken: 'passe' },
      { code: '123456' },
      { mfaToken: '', code: ' ' },
    ]) {
      const res = await request(app).post('/api/auth/login/mfa').send(body).expect(422);
      expect(res.body.error).toBe('validation_error');
    }
    const long = await request(app)
      .post('/api/auth/login/mfa')
      .send({ mfaToken: 'passe', code: '1'.repeat(33) })
      .expect(422);
    expect(long.body.details).toHaveProperty('code');
    expect(auth.loginMfa).not.toHaveBeenCalled();
  });

  it('as recusas do service saem como vieram (passe vencido, código errado, trava)', async () => {
    for (const err of [
      new HttpError(401, 'A verificação expirou.', 'invalid_mfa_token'),
      new HttpError(400, 'Código inválido.', 'invalid_mfa_code'),
      new HttpError(429, 'Muitas tentativas. Tente de novo em 15 minutos.', 'mfa_locked'),
    ]) {
      auth.loginMfa.mockRejectedValueOnce(err);
      const res = await request(app)
        .post('/api/auth/login/mfa')
        .send({ mfaToken: 'passe', code: '123456' })
        .expect(err.statusCode);
      expect(res.body).toEqual({ error: err.code, message: err.message });
    }
  });
});

describe('rotas da 2FA da própria conta', () => {
  const STATUS = {
    enabled: false,
    confirmedAt: null,
    recoveryCodesLeft: 0,
    available: true,
    required: false,
  };

  it('todas pedem login (401) e nenhuma chega ao service', async () => {
    for (const [method, path] of [
      ['get', '/api/auth/mfa'],
      ['post', '/api/auth/mfa/setup'],
      ['post', '/api/auth/mfa/enable'],
      ['post', '/api/auth/mfa/disable'],
      ['post', '/api/auth/mfa/recovery-codes'],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    for (const fn of Object.values(mfa)) expect(fn).not.toHaveBeenCalled();
  });

  it('GET /mfa devolve a situação da conta do token, com o papel atual', async () => {
    mfa.status.mockResolvedValue(STATUS);
    const res = await request(app).get('/api/auth/mfa').set(bearer(7, 'admin')).expect(200);
    expect(res.body).toEqual(STATUS);
    expect(mfa.status).toHaveBeenCalledWith(7, 'admin');
    expect(limiter).not.toHaveBeenCalled();
  });

  it('POST /mfa/setup pede a senha e passa pelo limite do login', async () => {
    mfa.setup.mockResolvedValue({ secret: 'ABC', otpauthUrl: 'otpauth://totp/x' });
    const res = await request(app)
      .post('/api/auth/mfa/setup')
      .set(bearer(7))
      .send({ password: 'senha-forte-123' })
      .expect(200);
    expect(res.body).toEqual({ secret: 'ABC', otpauthUrl: 'otpauth://totp/x' });
    expect(mfa.setup).toHaveBeenCalledWith(7, 'senha-forte-123');
    expect(limiter).toHaveBeenCalledTimes(1);

    const empty = await request(app).post('/api/auth/mfa/setup').set(bearer(7)).send({});
    expect(empty.status).toBe(422);
    expect(empty.body.details).toHaveProperty('password');
  });

  it('POST /mfa/enable leva o código e devolve a sessão nova e os códigos', async () => {
    const out = { ...TOKENS, recoveryCodes: ['AB12-CD34'] };
    mfa.enable.mockResolvedValue(out);
    const res = await request(app)
      .post('/api/auth/mfa/enable')
      .set(bearer(7))
      .set('User-Agent', AGENT)
      .send({ code: '123456' })
      .expect(200);
    expect(res.body).toEqual(out);
    expect(mfa.enable).toHaveBeenCalledWith(7, '123456', CTX);
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  it('POST /mfa/disable pede senha e código e responde 204 sem corpo', async () => {
    mfa.disable.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set(bearer(7))
      .set('User-Agent', AGENT)
      .send({ password: 'senha-forte-123', code: 'AB12-CD34' })
      .expect(204);
    expect(res.text).toBe('');
    expect(mfa.disable).toHaveBeenCalledWith(
      7,
      { password: 'senha-forte-123', code: 'AB12-CD34' },
      CTX,
    );
    expect(limiter).toHaveBeenCalledTimes(1);

    const noCode = await request(app)
      .post('/api/auth/mfa/disable')
      .set(bearer(7))
      .send({ password: 'senha-forte-123' });
    expect(noCode.status).toBe(422);
    expect(noCode.body.details).toHaveProperty('code');
  });

  it('POST /mfa/recovery-codes pede senha e código e devolve os códigos novos', async () => {
    mfa.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: ['EF56-GH78'] });
    const res = await request(app)
      .post('/api/auth/mfa/recovery-codes')
      .set(bearer(7))
      .set('User-Agent', AGENT)
      .send({ password: 'senha-forte-123', code: '123456' })
      .expect(200);
    expect(res.body).toEqual({ recoveryCodes: ['EF56-GH78'] });
    expect(mfa.regenerateRecoveryCodes).toHaveBeenCalledWith(
      7,
      { password: 'senha-forte-123', code: '123456' },
      CTX,
    );
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  describe('conta suspensa: a 2FA é segurança da conta e continua liberada', () => {
    beforeEach(() => blocklist.add(7, 'suspended'));
    afterEach(() => blocklist.delete(7));

    it('ver, começar, ativar, desativar e trocar os códigos passam', async () => {
      mfa.status.mockResolvedValue(STATUS);
      mfa.setup.mockResolvedValue({ secret: 'ABC', otpauthUrl: 'otpauth://totp/x' });
      mfa.enable.mockResolvedValue({ ...TOKENS, recoveryCodes: [] });
      mfa.disable.mockResolvedValue(undefined);
      mfa.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: [] });

      await request(app).get('/api/auth/mfa').set(bearer(7)).expect(200);
      await request(app)
        .post('/api/auth/mfa/setup')
        .set(bearer(7))
        .send({ password: 'x' })
        .expect(200);
      await request(app)
        .post('/api/auth/mfa/enable')
        .set(bearer(7))
        .send({ code: '1' })
        .expect(200);
      await request(app)
        .post('/api/auth/mfa/disable')
        .set(bearer(7))
        .send({ password: 'x', code: '1' })
        .expect(204);
      const res = await request(app)
        .post('/api/auth/mfa/recovery-codes')
        .set(bearer(7))
        .send({ password: 'x', code: '1' })
        .expect(200);
      expect(res.headers['x-account-status']).toBe('suspended');
    });
  });
});
