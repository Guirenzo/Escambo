import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
  email: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, `register ${role}: ${JSON.stringify(reg.body)}`).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, `login ${role}: ${JSON.stringify(login.body)}`).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken, email };
}

// Sanidade: o banco de teste está no ar antes de rodar a suíte.
beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status, 'API /health deve responder com o banco de teste no ar').toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Fluxo de contratação cash + escrow (ponta a ponta)', () => {
  it('create → accept → deliver → approve libera o escrow e concede XP', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');

    // Saldo inicial do freelancer zerado.
    const w0 = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w0.status).toBe(200);
    expect(w0.body).toMatchObject({ balance: 0, balancePending: 0 });

    // Cliente contrata: price 1000 → fee 150 (15%), net 850.
    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Landing page institucional',
        description: 'Página one-page responsiva com formulário de contato',
        price: 1000,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const contractId = created.body.id as number;
    expect(created.body).toMatchObject({ status: 'pending', platformFee: 150, freelancerNet: 850 });

    // Freelancer aceita → valor líquido entra em escrow (balance_pending).
    const acc = await request(app).post(`/api/contracts/${contractId}/accept`).set(auth(freelancer.token));
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.status).toBe('accepted');
    const w1 = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w1.body).toMatchObject({ balance: 0, balancePending: 850 });

    // Freelancer entrega.
    const del = await request(app)
      .post(`/api/contracts/${contractId}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Entrega final — arquivos e deploy no ar.' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.status).toBe('delivered');

    // Cliente aprova → escrow liberado (pending → balance) + XP de conclusão.
    const approved = await request(app).post(`/api/contracts/${contractId}/approve`).set(auth(client.token));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('completed');
    const w2 = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w2.body).toMatchObject({ balance: 850, balancePending: 0 });

    // Gamificação: o freelancer ganhou XP pela conclusão.
    const gam = await request(app).get('/api/gamification/me').set(auth(freelancer.token));
    expect(gam.status).toBe(200);
    expect(gam.body.totalXp).toBeGreaterThan(0);

    // O histórico registra a transição até 'completed'.
    const detail = await request(app).get(`/api/contracts/${contractId}`).set(auth(client.token));
    expect(detail.status).toBe(200);
    const statuses = (detail.body.history as { status: string }[]).map((h) => h.status);
    expect(statuses).toContain('completed');
  });

  it('cancelar após o aceite estorna o escrow retido', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');

    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'App mobile MVP',
        description: 'MVP com login social e listagem paginada',
        price: 500,
      });
    const id = created.body.id as number;

    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    const wA = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wA.body.balancePending).toBe(425); // 500 − 15%

    const cancel = await request(app).post(`/api/contracts/${id}/cancel`).set(auth(client.token));
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    const wB = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wB.body.balancePending).toBe(0); // escrow estornado
  });

  it('impõe autorização e autenticação nas transições', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const outsider = await registerAndLogin('client');

    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Consultoria SEO',
        description: 'Auditoria técnica e plano de ação de SEO',
        price: 300,
      });
    const id = created.body.id as number;

    // Cliente não pode aceitar (ação exclusiva do freelancer).
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(client.token)).expect(403);
    // Terceiro não participa → não enxerga o contrato.
    await request(app).get(`/api/contracts/${id}`).set(auth(outsider.token)).expect(403);
    // Sem token → 401.
    await request(app).get(`/api/contracts/${id}`).expect(401);
  });

  it('rejeita contratar a si mesmo (RN self_contract)', async () => {
    const freelancer = await registerAndLogin('freelancer');
    const res = await request(app)
      .post('/api/contracts')
      .set(auth(freelancer.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Serviço para mim mesmo',
        description: 'Não deveria ser permitido pela regra de negócio',
        price: 100,
      });
    expect(res.status).toBe(400);
  });
});
