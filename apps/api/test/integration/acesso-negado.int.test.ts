import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Tentativas de acesso não autorizado contra o MySQL real (RNF-018): a recusa por papel e o login
 * falho viram linhas consultáveis no audit_logs, com o IP de quem chamou (X-Forwarded-For atrás
 * do proxy confiável) e sem a query string nem o e-mail digitado. Token vencido não polui a tabela.
 */

const app = createApp();
const PASSWORD = 'senha-integracao-123';
let seq = 0;

async function register(role: 'client' | 'freelancer'): Promise<string> {
  const email = `int_negado_${Date.now()}_${seq++}@escambo.test`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASSWORD, role })
    .expect(201);
  return email;
}

async function login(email: string): Promise<{ id: number; token: string }> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { id: res.body.user.id, token: res.body.accessToken };
}

interface AuditRow extends RowDataPacket {
  user_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  new_value: unknown;
  ip_address: string | null;
  user_agent: string | null;
}

/** As linhas do audit_logs com este IP (cada teste usa um IP próprio, do bloco de documentação). */
async function rowsFrom(ip: string): Promise<AuditRow[]> {
  // O registro é best-effort e sai depois da resposta: espera ele chegar ao banco.
  for (let i = 0; i < 20; i++) {
    const [rows] = await pool.query<AuditRow[]>(
      'SELECT user_id, action, entity_type, entity_id, new_value, ip_address, user_agent FROM audit_logs WHERE ip_address = :ip ORDER BY id',
      { ip },
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

const json = (v: unknown): Record<string, unknown> =>
  (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

describe('acesso negado no audit_logs (RNF-018)', () => {
  it('quem não é admin e chama o painel fica registrado com id, rota, IP e navegador', async () => {
    const me = await login(await register('client'));
    const ip = '198.51.100.11';
    const res = await request(app)
      .get('/api/admin/metrics?token=nao-guardar')
      .set('Authorization', `Bearer ${me.token}`)
      .set('X-Forwarded-For', ip)
      .set('User-Agent', 'navegador-de-teste')
      .expect(403);
    expect(res.body.error).toBe('admin_only');

    const rows = await rowsFrom(ip);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: me.id,
      action: 'access.denied',
      entity_type: 'route',
      ip_address: ip,
      user_agent: 'navegador-de-teste',
    });
    expect(json(rows[0]!.new_value)).toEqual({
      method: 'GET',
      path: '/api/admin/metrics',
      status: 403,
      code: 'admin_only',
    });
  });

  it('senha errada registra a conta-alvo; conta inexistente registra sem o e-mail digitado', async () => {
    const email = await register('freelancer');
    const target = await login(email);
    const ip = '198.51.100.12';

    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'senha-errada-999' })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'ninguem_tem_esta_conta@escambo.test', password: PASSWORD })
      .expect(401);

    let rows = await rowsFrom(ip);
    for (let i = 0; rows.length < 2 && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await rowsFrom(ip);
    }
    expect(rows.map((r) => [r.action, r.user_id, r.entity_id])).toEqual([
      ['auth.login_failed', target.id, target.id],
      ['auth.login_failed', null, null],
    ]);
    expect(rows.map((r) => json(r.new_value))).toEqual([
      { reason: 'wrong_password' },
      { reason: 'unknown_account' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('ninguem_tem_esta_conta');
  });

  it('token inválido responde 401 e não grava nada: o app renova o token sozinho', async () => {
    const ip = '198.51.100.13';
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer token-que-nao-vale')
      .set('X-Forwarded-For', ip)
      .expect(401);
    await new Promise((r) => setTimeout(r, 200));
    const [rows] = await pool.query<AuditRow[]>(
      'SELECT id FROM audit_logs WHERE ip_address = :ip',
      { ip },
    );
    expect(rows).toHaveLength(0);
  });
});
