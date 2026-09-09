import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_barter_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const wallet = async (token: string) =>
  (await request(app).get('/api/wallet').set(auth(token))).body as {
    balance: number;
    balancePending: number;
  };

async function propose(proposer: Actor, receiver: Actor, offered: number, requested: number) {
  return request(app)
    .post('/api/barters')
    .set(auth(proposer.token))
    .send({
      receiverId: receiver.id,
      offeredDescription: `Ofereço serviço de ${offered}`,
      requestedDescription: `Quero serviço de ${requested}`,
      estimatedValueOffered: offered,
      estimatedValueRequested: requested,
    });
}

/** Leva um contrato da troca (já 'accepted') até 'completed': freelancer entrega, cliente aprova. */
async function completeLinked(contractId: number, freelancer: Actor, client: Actor): Promise<void> {
  const del = await request(app)
    .post(`/api/contracts/${contractId}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Entregue.' });
  expect(del.status, JSON.stringify(del.body)).toBe(200);
  const ok = await request(app)
    .post(`/api/contracts/${contractId}/approve`)
    .set(auth(client.token));
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Troca de serviços com torna de verdade (RN-066/RN-067)', () => {
  it('proponente paga: reserva na proposta (402 sem saldo), recusa devolve, aceite → conclusão liquida torna − taxa', async () => {
    const a = await registerAndLogin('freelancer'); // oferece 300, quer 400 → paga torna 100
    const b = await registerAndLogin('freelancer');
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const feesBefore = (await request(app).get('/api/admin/metrics').set(auth(admin.token))).body
      .platformFees as number;

    // Sem saldo, a proposta nem é criada.
    const broke = await propose(a, b, 300, 400);
    expect(broke.status).toBe(402);
    expect(broke.body.error).toBe('insufficient_balance');

    await fundWallet(app, a.token, 150);
    const first = await propose(a, b, 300, 400);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      cashDifference: 100,
      cashPayerId: a.id,
      platformFee: 15,
      tornaNet: 85,
      tornaStatus: 'held',
      status: 'proposed',
    });
    expect(await wallet(a.token)).toMatchObject({ balance: 50, balancePending: 100 });

    // Recusa: a torna volta na hora.
    await request(app).post(`/api/barters/${first.body.id}/reject`).set(auth(b.token)).expect(204);
    expect(await wallet(a.token)).toMatchObject({ balance: 150, balancePending: 0 });
    const afterReject = await request(app).get(`/api/barters/${first.body.id}`).set(auth(a.token));
    expect(afterReject.body).toMatchObject({ status: 'rejected', tornaStatus: 'refunded' });

    // Nova proposta aceita: 2 contratos recíprocos; torna continua reservada.
    const second = await propose(a, b, 300, 400);
    expect(second.status).toBe(201);
    const barterId = second.body.id as number;
    const accepted = await request(app).post(`/api/barters/${barterId}/accept`).set(auth(b.token));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'active', tornaStatus: 'held' });
    expect(await wallet(a.token)).toMatchObject({ balance: 50, balancePending: 100 });
    const offeredId = accepted.body.contractOfferedId as number; // A entrega para B
    const requestedId = accepted.body.contractRequestedId as number; // B entrega para A

    // Um lado concluído não liquida nada.
    await completeLinked(offeredId, a, b);
    expect(
      (await request(app).get(`/api/barters/${barterId}`).set(auth(a.token))).body.status,
    ).toBe('active');

    // Os dois lados concluídos: troca fecha, A deixa de ter retido, B recebe 85, plataforma 15.
    await completeLinked(requestedId, b, a);
    const done = await request(app).get(`/api/barters/${barterId}`).set(auth(a.token));
    expect(done.body).toMatchObject({ status: 'completed', tornaStatus: 'paid' });
    expect(await wallet(a.token)).toMatchObject({ balance: 50, balancePending: 0 });
    expect(await wallet(b.token)).toMatchObject({ balance: 85, balancePending: 0 });
    const ledgerB = await request(app).get('/api/wallet/transactions').set(auth(b.token));
    expect(ledgerB.body.items[0]).toMatchObject({ reason: 'barter_in', amount: 85 });
    const ledgerA = await request(app).get('/api/wallet/transactions').set(auth(a.token));
    expect(ledgerA.body.items[0]).toMatchObject({
      reason: 'barter_payment',
      amount: 0,
      pendingDelta: -100,
    });
    const feesAfter = (await request(app).get('/api/admin/metrics').set(auth(admin.token))).body
      .platformFees as number;
    expect(Math.round((feesAfter - feesBefore) * 100) / 100).toBe(15);
    expect(await waitForNotification(app, a.token, 'barter_completed')).toBe(true);
    expect(await waitForNotification(app, b.token, 'barter_completed')).toBe(true);
  });

  it('receptor paga: reserva só no aceite (402 sem saldo); contrato cancelado → disputa e torna devolvida', async () => {
    const a = await registerAndLogin('freelancer'); // oferece 400, quer 300 → B paga torna 100
    const b = await registerAndLogin('freelancer');

    const created = await propose(a, b, 400, 300);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      cashPayerId: b.id,
      tornaStatus: 'pending',
      platformFee: 15,
    });
    expect(await wallet(a.token)).toMatchObject({ balance: 0, balancePending: 0 });
    const barterId = created.body.id as number;

    // Receptor sem saldo não consegue aceitar; a troca continua proposta.
    const broke = await request(app).post(`/api/barters/${barterId}/accept`).set(auth(b.token));
    expect(broke.status).toBe(402);
    expect(
      (await request(app).get(`/api/barters/${barterId}`).set(auth(b.token))).body.status,
    ).toBe('proposed');

    await fundWallet(app, b.token, 100);
    const accepted = await request(app).post(`/api/barters/${barterId}/accept`).set(auth(b.token));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'active', tornaStatus: 'held' });
    expect(await wallet(b.token)).toMatchObject({ balance: 0, balancePending: 100 });

    // B (cliente do contrato oferecido) cancela → troca em disputa, torna volta para B.
    const cancel = await request(app)
      .post(`/api/contracts/${accepted.body.contractOfferedId}/cancel`)
      .set(auth(b.token));
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const disputed = await request(app).get(`/api/barters/${barterId}`).set(auth(a.token));
    expect(disputed.body).toMatchObject({ status: 'disputed', tornaStatus: 'refunded' });
    expect(await wallet(b.token)).toMatchObject({ balance: 100, balancePending: 0 });
    expect(await waitForNotification(app, a.token, 'barter_disputed')).toBe(true);
  });

  it('troca equilibrada: sem torna, sem taxa, sem reserva', async () => {
    const a = await registerAndLogin('freelancer');
    const b = await registerAndLogin('freelancer');
    const created = await propose(a, b, 250, 250);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      cashDifference: 0,
      cashPayerId: null,
      platformFee: 0,
      tornaNet: 0,
      tornaStatus: 'none',
    });
    await request(app)
      .post(`/api/barters/${created.body.id}/accept`)
      .set(auth(b.token))
      .expect(200);
    expect(await wallet(a.token)).toMatchObject({ balance: 0, balancePending: 0 });
    expect(await wallet(b.token)).toMatchObject({ balance: 0, balancePending: 0 });
  });
});
