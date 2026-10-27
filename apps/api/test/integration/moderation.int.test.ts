import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { confirmEmail } from './mail.helpers';

/**
 * Moderação efetiva (RN-007): suspensão mantém sessão de consulta e bloqueia negócios;
 * reativação libera o JWT vigente; banimento nega acesso/login e revoga refresh.
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
    .send({ legalAccepted: true, email, password: PASSWORD, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  await confirmEmail(app, login.body.user.id);
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
  it('suspender mantém consulta/login/refresh, bloqueia negócios; reativar libera o mesmo JWT; banir revoga o acesso', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const target = await registerAndLogin('freelancer');

    // Antes: acesso normal.
    expect((await request(app).get('/api/auth/me').set(auth(target.token))).status).toBe(200);

    // Suspender.
    const susp = await request(app)
      .post(`/api/admin/users/${target.ulid}/suspend`)
      .set(auth(admin.token));
    expect(susp.status, JSON.stringify(susp.body)).toBeLessThan(300);

    // Token vigente continua consultando; sessão renovada e login continuam restritos.
    const me = await request(app).get('/api/auth/me').set(auth(target.token));
    expect(me.status).toBe(200);
    expect(me.body.status).toBe('suspended');
    expect(me.headers['x-account-status']).toBe('suspended');
    const blocked = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(target.token))
      .send({ amount: 50 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('account_suspended');
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: target.refreshToken });
    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toEqual(expect.any(String));
    const renewed = await request(app).get('/api/auth/me').set(auth(refresh.body.accessToken));
    expect(renewed.status).toBe(200);
    expect(renewed.body.status).toBe('suspended');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: target.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.status).toBe('suspended');

    // Reativar libera escrita com o token original, sem exigir nova entrada.
    const react = await request(app)
      .post(`/api/admin/users/${target.ulid}/reactivate`)
      .set(auth(admin.token));
    expect(react.status).toBeLessThan(300);
    const active = await request(app).get('/api/auth/me').set(auth(target.token));
    expect(active.status).toBe(200);
    expect(active.body.status).toBe('active');
    await request(app)
      .post('/api/wallet/deposits')
      .set(auth(target.token))
      .send({ amount: 50 })
      .expect(201);
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
    for (const token of [
      target.token,
      refresh.body.accessToken,
      login.body.accessToken,
      login2.body.accessToken,
    ]) {
      const denied = await request(app).get('/api/auth/me').set(auth(token));
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('account_blocked');
    }
    for (const refreshToken of [
      refresh.body.refreshToken,
      login.body.refreshToken,
      login2.body.refreshToken,
    ]) {
      const revoked = await request(app).post('/api/auth/refresh').send({ refreshToken });
      expect(revoked.status).toBe(401);
      expect(revoked.body.error).toBe('invalid_refresh');
    }
    const [sessions] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL',
      [target.id],
    );
    expect(Number(sessions[0]!.n)).toBe(0);
  });

  it('admin não suspende nem bane a si mesmo nem outro admin (409), e a ação registra o id do moderado', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const other = await registerAndLogin('client', 'admin.escambo.test');
    const target = await registerAndLogin('freelancer');
    const statuses = async (): Promise<unknown[]> => {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT status FROM users WHERE id IN (?, ?) ORDER BY id',
        [admin.id, other.id],
      );
      return rows.map((r) => r.status);
    };
    const before = await statuses();

    for (const ulid of [admin.ulid, other.ulid]) {
      for (const action of ['suspend', 'ban']) {
        const res = await request(app)
          .post(`/api/admin/users/${ulid}/${action}`)
          .set(auth(admin.token));
        expect(res.status, `${action} ${ulid}`).toBe(409);
        expect(res.body).toEqual({
          error: 'cannot_moderate_admin',
          message: 'Administradores não são suspensos nem banidos pelo painel.',
        });
      }
    }
    // Nada mudou: o status dos dois admins é o mesmo e o painel segue aberto para eles.
    expect(await statuses()).toEqual(before);
    expect(before).not.toContain('suspended');
    expect(before).not.toContain('banned');
    for (const a of [admin, other]) {
      expect((await request(app).get('/api/admin/metrics').set(auth(a.token))).status).toBe(200);
    }

    // Usuário comum: a ação fica em admin_actions com o alvo (tipo e id), filtrável por usuário.
    await request(app)
      .post(`/api/admin/users/${target.ulid}/suspend`)
      .set(auth(admin.token))
      .expect(204);
    const [actions] = await pool.query<RowDataPacket[]>(
      `SELECT action, target_type, target_id, description FROM admin_actions
        WHERE admin_id = ? ORDER BY id`,
      [admin.id],
    );
    expect(actions).toEqual([
      {
        action: 'user_suspend',
        target_type: 'user',
        target_id: target.id,
        description: `ulid=${target.ulid}`,
      },
    ]);
  });
});
