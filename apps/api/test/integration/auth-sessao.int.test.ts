import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Sessões contra o MySQL real: a rotação do refresh token vale uma vez só, mesmo com requisições
 * simultâneas (a revogação condicional é que decide), e um User-Agent maior que a coluna não
 * derruba cadastro, login nem refresh (sql_mode estrito).
 */
const app = createApp();

let seq = 0;
async function registerAndLogin(
  userAgent = 'vitest-integracao',
): Promise<{ id: number; refreshToken: string }> {
  const email = `int_sessao_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .set('User-Agent', userAgent)
    .send({ legalAccepted: true, email, password, role: 'client' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app)
    .post('/api/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, refreshToken: login.body.refreshToken };
}

async function openSessions(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = :userId AND revoked_at IS NULL',
    { userId },
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('sessões: rotação do refresh token e User-Agent longo', () => {
  it('renovações simultâneas com o mesmo refresh token: só uma leva par novo, as outras são 401 invalid_refresh', async () => {
    const user = await registerAndLogin();
    expect(await openSessions(user.id)).toBe(1);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app).post('/api/auth/refresh').send({ refreshToken: user.refreshToken }),
      ),
    );

    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({
        error: 'invalid_refresh',
        message: 'Refresh token inválido ou expirado',
      });
    }
    // Uma sessão aberta só: a do par que saiu. A antiga ficou revogada.
    expect(await openSessions(user.id)).toBe(1);

    // O par novo renova; o token antigo não vale mais.
    const next = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: ok[0]!.body.refreshToken });
    expect(next.status).toBe(200);
    const old = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: user.refreshToken });
    expect(old.status).toBe(401);
  });

  it('User-Agent acima de 512 caracteres não derruba cadastro, login nem refresh: grava cortado', async () => {
    const longAgent = `Mozilla/5.0 ${'x'.repeat(1000)}`;
    const user = await registerAndLogin(longAgent);

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('User-Agent', longAgent)
      .send({ refreshToken: user.refreshToken });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);

    // Login e refresh: duas sessões gravadas, cada uma com os primeiros 512 caracteres.
    const [sessions] = await pool.query<RowDataPacket[]>(
      'SELECT user_agent FROM user_sessions WHERE user_id = :userId ORDER BY id',
      { userId: user.id },
    );
    expect(sessions.map((s) => s.user_agent)).toEqual([
      longAgent.slice(0, 512),
      longAgent.slice(0, 512),
    ]);
    // O aceite do cadastro (Termos e Política) também ficou registrado, com o navegador cortado.
    const [consents] = await pool.query<RowDataPacket[]>(
      'SELECT type, user_agent FROM lgpd_consents WHERE user_id = :userId ORDER BY id',
      { userId: user.id },
    );
    expect(consents).toEqual([
      { type: 'terms_of_use', user_agent: longAgent.slice(0, 512) },
      { type: 'privacy_policy', user_agent: longAgent.slice(0, 512) },
    ]);
  });
});
