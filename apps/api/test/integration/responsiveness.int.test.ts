import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Responsividade do Escambo Score sai de dados reais: quando o freelancer responde a uma
 * mensagem do cliente no chat, o tempo decorrido vira amostra do tempo médio de resposta.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `resp_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Responsividade (tempo de resposta no chat → Escambo Score)', () => {
  it('freelancer sem histórico tem responsividade neutra; ao responder rápido, vai a 100', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 100);
    const profile = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(freelancer.token))
      .send({ fullName: 'Freela Ágil', city: 'Joinville' });
    expect(profile.status).toBeLessThan(300);

    const before = await request(app).get('/api/profiles/me').set(auth(freelancer.token));
    expect(before.body.freelancer.escamboScore.breakdown.responsiveness).toBe(50);

    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Contrato com chat',
      description: 'Contratação do teste de responsividade',
      price: 100,
    });
    expect(created.status).toBe(201);
    const contractId = created.body.id as number;

    // Freelancer fala primeiro: não é resposta, não conta.
    const first = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .send({ content: 'Oi! Recebi sua proposta.' });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 150));
    const still = await request(app).get('/api/profiles/me').set(auth(freelancer.token));
    expect(still.body.freelancer.escamboScore.breakdown.responsiveness).toBe(50);

    // Cliente pergunta, freelancer responde em segundos → tempo de resposta ~0h → 100.
    const ask = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .send({ content: 'Consegue começar amanhã?' });
    expect(ask.status).toBe(201);
    const reply = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .send({ content: 'Consigo sim!' });
    expect(reply.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));

    const after = await request(app).get('/api/profiles/me').set(auth(freelancer.token));
    expect(after.body.freelancer.escamboScore.breakdown.responsiveness).toBe(100);
  });
});
