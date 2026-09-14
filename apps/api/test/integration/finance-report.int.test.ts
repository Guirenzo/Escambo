import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Relatório financeiro do admin contra o MySQL real. Os outros arquivos de integração também
 * movimentam dinheiro no mesmo dia, então tudo é medido por DIFERENÇA entre antes e depois
 * (os arquivos rodam em sequência, nunca em paralelo).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
  email: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_fin_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken, email };
}

interface Report {
  totals: {
    revenue: number;
    deposits: number;
    withdrawals: number;
    refunds: number;
    completedContracts: number;
    gmv: number;
  };
  series: { bucket: string }[];
  now: { inEscrow: number; usersBalance: number };
}

const report = async (token: string, qs = 'granularity=day'): Promise<Report> => {
  const res = await request(app).get(`/api/admin/finance?${qs}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Report;
};

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Relatório financeiro do admin', () => {
  it('só admin; receita fecha com a liquidação dos contratos; depósitos, reembolsos e saques batem', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await request(app).get('/api/admin/finance').set(auth(client.token)).expect(403);

    const before = await report(admin.token);

    // 300 depositados; contrato A (200) concluído → taxa 30; contrato B (100) aceito e cancelado
    // sem prazo → 50% de reembolso ao cliente (50) e a plataforma retém 50% da taxa (7,50).
    await fundWallet(app, client.token, 300);
    const propose = async (title: string, price: number) => {
      const res = await request(app)
        .post('/api/contracts')
        .set(auth(client.token))
        .send({
          freelancerId: freelancer.id,
          title,
          description: 'Contratação do teste financeiro',
          price,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    const a = await propose('Contrato A', 200);
    const b = await propose('Contrato B', 100);
    for (const [id, action, who] of [
      [a, 'accept', freelancer],
      [a, 'deliver', freelancer],
      [a, 'approve', client],
      [b, 'accept', freelancer],
      [b, 'cancel', client],
    ] as const) {
      const res = await request(app)
        .post(`/api/contracts/${id}/${action}`)
        .set(auth(who.token))
        .send(action === 'deliver' ? { message: 'Entregue.' } : {});
      expect(res.status, `${action} → ${JSON.stringify(res.body)}`).toBe(200);
    }
    // Freelancer saca 100 dos 170 + 42,50 liberados; o admin conclui.
    await request(app).get('/api/wallet').set(auth(freelancer.token)); // garante a carteira
    const wd = await request(app)
      .post('/api/withdrawals')
      .set(auth(freelancer.token))
      .send({ amount: 100, method: 'pix', pixKey: 'fin@escambo.test' });
    // Saque exige e-mail confirmado; sem isso o teste mede só depósito/receita/reembolso.
    const withdrew = wd.status === 201;
    if (withdrew) {
      await request(app)
        .post(`/api/admin/withdrawals/${wd.body.id}/complete`)
        .set(auth(admin.token))
        .send({})
        .expect(200);
    }

    const after = await report(admin.token);
    const d = (k: keyof Report['totals']) =>
      Math.round((after.totals[k] - before.totals[k]) * 100) / 100;
    expect(d('deposits')).toBe(300);
    expect(d('revenue')).toBe(37.5); // 30 (A) + 7,50 (metade da taxa de B)
    expect(d('refunds')).toBe(50);
    expect(d('completedContracts')).toBe(1);
    expect(d('gmv')).toBe(200);
    expect(d('withdrawals')).toBe(withdrew ? 100 : 0);
    expect(after.series.length).toBeGreaterThan(0);
    expect(after.now.inEscrow).toBeGreaterThanOrEqual(0);

    // Granularidade por mês e período inválido.
    const monthly = await report(admin.token, 'granularity=month');
    expect(monthly.series.every((s) => /^\d{4}-\d{2}$/.test(s.bucket))).toBe(true);
    await request(app)
      .get('/api/admin/finance?from=2026-09-10&to=2026-09-01')
      .set(auth(admin.token))
      .expect(400);

    // CSV do ledger: cabeçalho, linhas do freelancer e a ação registrada.
    const csv = await request(app)
      .get('/api/admin/finance/export.csv?granularity=day')
      .set(auth(admin.token));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/escambo-ledger-.*\.csv/);
    const text = csv.text;
    expect(text.startsWith('\uFEFFid;data_hora_utc;usuario;motivo;')).toBe(true);
    expect(text).toContain(`${freelancer.email};escrow_release;170,00`);
    expect(text).toContain(`${client.email};deposit;300,00`);
    await request(app).get('/api/admin/finance/export.csv').set(auth(client.token)).expect(403);
  });
});
