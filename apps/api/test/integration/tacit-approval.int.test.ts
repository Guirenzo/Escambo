import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';
import { runTacitApproval } from '../../src/jobs/tacit-approval';
import { DAY, fromNow, HOUR, now, startDaytimeClock, stopClock } from './clock.helpers';

/**
 * Aprovação tácita (RN-024, ADR 57): a hora é gravada na entrega (5 dias corridos, nunca de noite
 * no fuso do cliente) e o job aprova quando ela passa, com liberação do escrow e registro no
 * histórico. Entregas recentes ficam como estão; de noite no fuso do cliente, nada acontece.
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
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
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
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Aprovação tácita (job)', () => {
  it('aprova a entrega vencida, libera o escrow e registra o motivo; a recente fica entregue', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 400);

    const old = await deliveredContract(client, freelancer, 'Entrega antiga sem resposta');
    const recent = await deliveredContract(client, freelancer, 'Entrega recente');

    // A hora foi gravada na entrega: 5 dias corridos depois, de dia no fuso do cliente.
    const [[row]] = (await pool.query('SELECT approval_due_at FROM contracts WHERE id = :id', {
      id: recent,
    })) as unknown as [[{ approval_due_at: Date }]];
    const due = new Date(row.approval_due_at).getTime();
    expect(due).toBeGreaterThanOrEqual(now().getTime() + 5 * DAY - 2000);
    expect(due).toBeLessThanOrEqual(now().getTime() + 5 * DAY + 13 * HOUR);
    const shown = await request(app).get(`/api/contracts/${recent}`).set(auth(client.token));
    expect(shown.body.approvalDueAt).toBe(new Date(due).toISOString());

    // Simula o tempo: a aprovação tácita da antiga já venceu.
    await pool.query('UPDATE contracts SET approval_due_at = :due WHERE id = :id', {
      id: old,
      due: fromNow(-HOUR),
    });

    // De noite (03:00 em Brasília, 01:00 em Rio Branco…) o job não aprova nada.
    const night = new Date(now().getTime() + 15 * HOUR);
    expect((await runTacitApproval(night)).approved).not.toContain(old);

    const result = await runTacitApproval(now());
    expect(result.zones.length).toBeGreaterThan(0);
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
    const again = await runTacitApproval(now());
    expect(again.approved).not.toContain(old);
    expect(again.approved).not.toContain(recent);
  });
});
