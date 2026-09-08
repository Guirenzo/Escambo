import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runTacitApproval } from '../../src/jobs/tacit-approval';

/**
 * Aprovação tácita: entrega sem resposta do cliente além do prazo da plataforma é aprovada pelo
 * job, com liberação do escrow e registro no histórico. Entregas recentes ficam como estão.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `tacit_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

/** Contratação entregue (create → accept → deliver). */
async function deliveredContract(client: Actor, freelancer: Actor, title: string): Promise<number> {
  const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    title,
    description: 'Contratação do teste de aprovação tácita',
    price: 200,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  const acc = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token));
  expect(acc.status).toBe(200);
  const del = await request(app)
    .post(`/api/contracts/${id}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Entregue.' });
  expect(del.status).toBe(200);
  return id;
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Aprovação tácita (job)', () => {
  it('aprova a entrega vencida, libera o escrow e registra o motivo; a recente fica entregue', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');

    const old = await deliveredContract(client, freelancer, 'Entrega antiga sem resposta');
    const recent = await deliveredContract(client, freelancer, 'Entrega recente');

    // Simula o tempo: a entrega antiga aconteceu há 6 dias (prazo padrão da plataforma: 5).
    await pool.query(
      `UPDATE contract_status_history
          SET created_at = DATE_SUB(NOW(), INTERVAL 6 DAY)
        WHERE contract_id = :id AND new_status = 'delivered'`,
      { id: old },
    );

    const result = await runTacitApproval();
    expect(result.days).toBeGreaterThan(0);
    expect(result.approved).toContain(old);
    expect(result.approved).not.toContain(recent);
    expect(result.failed).toEqual([]);

    const oldDetail = await request(app).get(`/api/contracts/${old}`).set(auth(client.token));
    expect(oldDetail.body.status).toBe('completed');
    const last = oldDetail.body.history.at(-1);
    expect(last).toMatchObject({ status: 'completed', previousStatus: 'delivered' });
    expect(String(last.note)).toContain('Aprovação tácita');

    const recentDetail = await request(app).get(`/api/contracts/${recent}`).set(auth(client.token));
    expect(recentDetail.body.status).toBe('delivered');

    // Escrow da antiga liberado (200 - 15% = 170); a recente segue retida.
    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ balance: 170, balancePending: 170 });

    // Idempotente: rodar de novo não aprova nada a mais.
    const again = await runTacitApproval();
    expect(again.approved).toEqual([]);
  });
});
