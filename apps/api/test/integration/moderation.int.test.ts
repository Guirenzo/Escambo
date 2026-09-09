import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Moderação efetiva (RN-007): suspender/banir derruba o acesso na hora (token vigente nega),
 * revoga as sessões (refresh nega) e bloqueia novos logins; reativar libera de novo.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  ulid: string;
  email: string;
  token: string;
  refreshToken: string;
}

const PASSWORD = 'senha-integracao-123';
let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `mod_${role}_${Date.now()}_${seq++}@${domain}`;
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email, password: PASSWORD, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return {
    id: login.body.user.id,
    ulid: login.body.user.ulid,
    email,
    token: login.body.accessToken,
    refreshToken: login.body.refreshToken,
  };
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Moderação efetiva', () => {
  it('suspender bloqueia token vigente, refresh e login; reativar libera; banir bloqueia de novo', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const target = await registerAndLogin('freelancer');

    // Antes: acesso normal.
    expect((await request(app).get('/api/auth/me').set(auth(target.token))).status).toBe(200);

    // Suspender.
    const susp = await request(app)
      .post(`/api/admin/users/${target.ulid}/suspend`)
      .set(auth(admin.token));
    expect(susp.status, JSON.stringify(susp.body)).toBeLessThan(300);

    // Token vigente é negado na hora; refresh e login também.
    const me = await request(app).get('/api/auth/me').set(auth(target.token));
    expect(me.status).toBe(403);
    expect(me.body.error).toBe('account_blocked');
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: target.refreshToken });
    expect(refresh.status).toBeGreaterThanOrEqual(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: target.email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error).toBe('account_suspended');

    // Reativar: login volta a funcionar e o token novo passa.
    const react = await request(app)
      .post(`/api/admin/users/${target.ulid}/reactivate`)
      .set(auth(admin.token));
    expect(react.status).toBeLessThan(300);
    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ email: target.email, password: PASSWORD });
    expect(login2.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(login2.body.accessToken))).status).toBe(
      200,
    );

    // Banir: código específico no login.
    const ban = await request(app)
      .post(`/api/admin/users/${target.ulid}/ban`)
      .set(auth(admin.token));
    expect(ban.status).toBeLessThan(300);
    const login3 = await request(app)
      .post('/api/auth/login')
      .send({ email: target.email, password: PASSWORD });
    expect(login3.status).toBe(403);
    expect(login3.body.error).toBe('account_banned');
    expect((await request(app).get('/api/auth/me').set(auth(login2.body.accessToken))).status).toBe(
      403,
    );
  });
});
