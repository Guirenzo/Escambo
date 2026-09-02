import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<{ id: number; token: string }> {
  const email = `cred_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

/** GET /wallet concede o bônus de boas-vindas (uma vez) e devolve os saldos. */
async function wallet(token: string): Promise<{ credits: number; creditsPending: number }> {
  const res = await request(app).get('/api/wallet').set(auth(token));
  expect(res.status).toBe(200);
  return { credits: res.body.credits, creditsPending: res.body.creditsPending };
}

afterAll(async () => {
  await pool.end();
});

describe('Créditos Escambo (time-bank) — fluxo ponta a ponta', () => {
  it('bônus de boas-vindas é creditado uma única vez', async () => {
    const u = await registerAndLogin('client');
    const first = await wallet(u.token);
    expect(first.credits).toBe(100); // CREDITS_WELCOME_BONUS
    const second = await wallet(u.token);
    expect(second.credits).toBe(100); // não duplica
  });

  it('contrato em créditos: escrow no aceite → liberação na aprovação', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await wallet(client.token); // 100 créditos
    await wallet(freelancer.token); // 100 créditos

    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Aula de violão (créditos)',
        description: 'Troco aula de violão por créditos Escambo',
        price: 40,
        paymentMode: 'credits',
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ paymentMode: 'credits', platformFee: 0, freelancerNet: 40 });
    const id = created.body.id as number;

    // Aceite: 40 créditos saem do cliente e ficam pendentes para o freelancer.
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    expect(await wallet(client.token)).toEqual({ credits: 60, creditsPending: 0 });
    expect(await wallet(freelancer.token)).toEqual({ credits: 100, creditsPending: 40 });

    // Entrega + aprovação: libera o pendente do freelancer.
    await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Aula concluída' })
      .expect(200);
    await request(app).post(`/api/contracts/${id}/approve`).set(auth(client.token)).expect(200);

    expect(await wallet(client.token)).toEqual({ credits: 60, creditsPending: 0 });
    expect(await wallet(freelancer.token)).toEqual({ credits: 140, creditsPending: 0 });

    // Extrato do freelancer registra a entrada em escrow.
    const ext = await request(app).get('/api/credits/transactions').set(auth(freelancer.token));
    expect(ext.status).toBe(200);
    const reasons = (ext.body.items as { reason: string }[]).map((t) => t.reason);
    expect(reasons).toContain('escrow_in');
    expect(reasons).toContain('welcome');
  });

  it('cancelar após o aceite estorna os créditos ao cliente', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await wallet(client.token);
    await wallet(freelancer.token);

    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Design de logo (créditos)',
        description: 'Logo simples pago em créditos',
        price: 30,
        paymentMode: 'credits',
      })
      .expect(201);
    const id = created.body.id as number;

    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    expect((await wallet(client.token)).credits).toBe(70);

    await request(app).post(`/api/contracts/${id}/cancel`).set(auth(client.token)).expect(200);
    expect(await wallet(client.token)).toEqual({ credits: 100, creditsPending: 0 });
    expect(await wallet(freelancer.token)).toEqual({ credits: 100, creditsPending: 0 });
  });

  it('aceite falha com 409 quando o cliente não tem créditos suficientes', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await wallet(client.token); // só 100 créditos

    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send({
        freelancerId: freelancer.id,
        title: 'Serviço caro em créditos',
        description: 'Custa mais créditos do que o cliente tem',
        price: 500,
        paymentMode: 'credits',
      })
      .expect(201);
    const id = created.body.id as number;

    const acc = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token));
    expect(acc.status).toBe(409);
    expect(acc.body.error).toBe('insufficient_credits');
  });
});
