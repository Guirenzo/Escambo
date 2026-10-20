import { createHmac } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { authenticate } from '../../middlewares/authenticate';
import { routerApp, tokenFor } from '../../test-support/http';
import { MFA_TOKEN_TTL_SECONDS, signMfaToken, verifyMfaToken } from './mfa-token';

const ULID = '01HZXULIDEXAMPLE0000000000';
const derivedKey = createHmac('sha256', env.JWT_SECRET).update('escambo:mfa-token:').digest();

afterEach(() => vi.useRealTimers());

/** O passe entre a senha e o segundo fator (ADR 66): curto, de uso restrito e com chave própria. */
describe('passe do segundo fator (mfaToken)', () => {
  it('leva o ulid da conta e o propósito, e vence em 5 minutos', () => {
    const token = signMfaToken(ULID);
    const claims = jwt.verify(token, derivedKey) as jwt.JwtPayload;
    expect(claims).toMatchObject({ sub: ULID, purpose: 'mfa' });
    expect(claims.exp! - claims.iat!).toBe(MFA_TOKEN_TTL_SECONDS);
    expect(MFA_TOKEN_TTL_SECONDS).toBe(300);
    expect(verifyMfaToken(token)).toBe(ULID);
  });

  it('vencido não vale', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
    const token = signMfaToken(ULID);
    vi.setSystemTime(new Date('2026-10-20T12:05:01Z'));
    expect(verifyMfaToken(token)).toBeNull();
  });

  it('o token de acesso (assinado com o JWT_SECRET) não serve como passe', () => {
    expect(verifyMfaToken(tokenFor(7))).toBeNull();
    // Nem com as claims do passe, se a chave é a do acesso.
    const forged = jwt.sign({ purpose: 'mfa' }, env.JWT_SECRET, { subject: ULID, expiresIn: 60 });
    expect(verifyMfaToken(forged)).toBeNull();
  });

  it('com a chave certa, mas sem o propósito ou sem a conta, também não', () => {
    expect(
      verifyMfaToken(jwt.sign({ purpose: 'login' }, derivedKey, { subject: ULID })),
    ).toBeNull();
    expect(verifyMfaToken(jwt.sign({ purpose: 'mfa' }, derivedKey))).toBeNull();
    expect(verifyMfaToken(jwt.sign('texto-solto', derivedKey))).toBeNull();
    expect(verifyMfaToken('nem-é-jwt')).toBeNull();
  });

  it('o authenticate nunca aceita o passe como token de acesso (401 invalid_token)', async () => {
    const handler = vi.fn((_req, res) => res.json({ ok: true }));
    const router = Router();
    router.get('/me', authenticate, handler);
    const app = routerApp('/api/auth', router);

    const res = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${signMfaToken(ULID)}` })
      .expect(401);

    expect(res.body.error).toBe('invalid_token');
    expect(handler).not.toHaveBeenCalled();
    // E o mesmo app aceita o token de acesso de verdade.
    await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${tokenFor(7)}` })
      .expect(200);
  });
});
