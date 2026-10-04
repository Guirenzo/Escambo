import type { RowDataPacket } from 'mysql2';
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
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
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

  it('destinatário inexistente é 404 e serviço de outra pessoa ou removido é 422 (não o 500 da FK)', async () => {
    const a = await registerAndLogin('freelancer');
    const b = await registerAndLogin('freelancer');
    const c = await registerAndLogin('freelancer');
    const serviceOf = async (owner: Actor): Promise<number> => {
      const res = await request(app)
        .post('/api/services')
        .set(auth(owner.token))
        .send({
          categoryId: 10,
          title: `Serviço da troca ${seq++}`,
          description: 'Serviço de teste para a proposta de troca',
          priceType: 'fixed',
          price: 100,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    const ofA = await serviceOf(a);
    const ofB = await serviceOf(b);
    const ofC = await serviceOf(c);
    const base = {
      receiverId: b.id,
      offeredServiceId: ofA,
      requestedServiceId: ofB,
      estimatedValueOffered: 100,
      estimatedValueRequested: 100,
    };
    const send = (body: Record<string, unknown>) =>
      request(app).post('/api/barters').set(auth(a.token)).send(body);
    const count = async (): Promise<number> => {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM barter_agreements WHERE proposer_id = ?',
        [a.id],
      );
      return Number(rows[0]!.n);
    };

    const ghost = await send({ ...base, receiverId: 999_999_999 });
    expect(ghost.status, JSON.stringify(ghost.body)).toBe(404);
    expect(ghost.body.error).toBe('user_not_found');

    // Oferecer o serviço de um terceiro, ou pedir ao receptor um serviço que não é dele.
    expect((await send({ ...base, offeredServiceId: ofC })).body.error).toBe(
      'invalid_offered_service',
    );
    expect((await send({ ...base, requestedServiceId: ofC })).status).toBe(422);
    expect((await send({ ...base, requestedServiceId: 999_999_999 })).body.error).toBe(
      'invalid_requested_service',
    );
    // Serviço removido não entra em troca nova.
    await pool.query('UPDATE services SET deleted_at = NOW() WHERE id = ?', [ofA]);
    const removed = await send(base);
    expect(removed.status).toBe(422);
    expect(removed.body.error).toBe('invalid_offered_service');
    expect(await count()).toBe(0);

    await pool.query('UPDATE services SET deleted_at = NULL WHERE id = ?', [ofA]);
    const ok = await send(base);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ offeredServiceId: ofA, requestedServiceId: ofB });
    expect(await count()).toBe(1);
  });

  it('destinatário suspenso ou banido é 404 e serviço pausado, pedido ou oferecido, é 409 (RN-013), sem reservar a torna', async () => {
    const a = await registerAndLogin('freelancer'); // oferece 300, quer 400 → paga torna 100
    const b = await registerAndLogin('freelancer');
    await fundWallet(app, a.token, 100);
    const cats = await request(app).get('/api/categories');
    const serviceOf = async (owner: Actor): Promise<number> => {
      const res = await request(app)
        .post('/api/services')
        .set(auth(owner.token))
        .send({
          categoryId: cats.body[0].id,
          title: `Serviço da troca ${seq++}`,
          description: 'Serviço de teste para a proposta de troca',
          priceType: 'fixed',
          price: 300,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    const setActive = async (owner: Actor, id: number, isActive: boolean) =>
      request(app)
        .patch(`/api/services/${id}`)
        .set(auth(owner.token))
        .send({ isActive })
        .expect(200);
    const ofA = await serviceOf(a);
    const ofB = await serviceOf(b);
    const body = {
      receiverId: b.id,
      offeredServiceId: ofA,
      requestedServiceId: ofB,
      estimatedValueOffered: 300,
      estimatedValueRequested: 400,
    };
    const send = () => request(app).post('/api/barters').set(auth(a.token)).send(body);
    const count = async (): Promise<number> => {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM barter_agreements WHERE proposer_id = ?',
        [a.id],
      );
      return Number(rows[0]!.n);
    };

    // Conta suspensa ou banida pela moderação não recebe proposta, como na contratação direta.
    for (const status of ['suspended', 'banned']) {
      await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, b.id]);
      const blocked = await send();
      expect(blocked.status, `${status}: ${JSON.stringify(blocked.body)}`).toBe(404);
      expect(blocked.body).toEqual({ error: 'user_not_found', message: 'Usuário não encontrado' });
    }
    await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [b.id]);

    // O receptor pausou o serviço pedido: a mesma recusa da contratação.
    await setActive(b, ofB, false);
    const requestedPaused = await send();
    expect(requestedPaused.status, JSON.stringify(requestedPaused.body)).toBe(409);
    expect(requestedPaused.body).toEqual({
      error: 'service_inactive',
      message: 'Este serviço está pausado e não aceita novas propostas (RN-013).',
    });
    await setActive(b, ofB, true);

    // O proponente oferece o próprio serviço pausado.
    await setActive(a, ofA, false);
    const offeredPaused = await send();
    expect(offeredPaused.status, JSON.stringify(offeredPaused.body)).toBe(409);
    expect(offeredPaused.body).toEqual({
      error: 'service_inactive',
      message: 'O serviço oferecido está pausado: reative-o para propor a troca (RN-013).',
    });

    // Nenhuma das recusas gravou troca nem reservou a torna.
    expect(await count()).toBe(0);
    expect(await wallet(a.token)).toMatchObject({ balance: 100, balancePending: 0 });

    // Os dois no ar e o receptor ativo: a proposta passa e a torna fica reservada.
    await setActive(a, ofA, true);
    const ok = await send();
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ offeredServiceId: ofA, requestedServiceId: ofB });
    expect(await count()).toBe(1);
    expect(await wallet(a.token)).toMatchObject({ balance: 0, balancePending: 100 });
  });

  it('valores estimados: centavo exato e até o limite da coluna DECIMAL(10,2)', async () => {
    const a = await registerAndLogin('freelancer');
    const b = await registerAndLogin('freelancer');

    // 100,004 x 100,006 seriam gravados 100,00 x 100,01 com torna 0,00 e pagador preenchido.
    const fraction = await propose(a, b, 100.004, 100.006);
    expect(fraction.status).toBe(422);
    expect(Object.keys(fraction.body.details).sort()).toEqual([
      'estimatedValueOffered',
      'estimatedValueRequested',
    ]);
    expect((await propose(a, b, 100_000_000, 1)).status).toBe(422);

    // No limite: quem paga a torna é o receptor (reserva só no aceite), e tudo cabe nas colunas.
    const atLimit = await propose(a, b, 99_999_999.99, 1);
    expect(atLimit.status, JSON.stringify(atLimit.body)).toBe(201);
    expect(atLimit.body).toMatchObject({
      estimatedValueOffered: 99_999_999.99,
      estimatedValueRequested: 1,
      cashDifference: 99_999_998.99,
      cashPayerId: b.id,
      platformFee: 14_999_999.85,
      tornaStatus: 'pending',
    });
  });

  it('carteira inconsistente na devolução da torna: 500 e a troca continua proposta com a torna retida', async () => {
    const a = await registerAndLogin('freelancer'); // oferece 300, quer 400 → paga torna 100
    const b = await registerAndLogin('freelancer');
    await fundWallet(app, a.token, 100);
    const created = await propose(a, b, 300, 400);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const barterId = created.body.id as number;

    // Retido some por fora (inconsistência): a devolução de 100 deixaria o retido negativo.
    await pool.query('UPDATE wallets SET balance_pending = 0 WHERE user_id = ?', [a.id]);
    const reject = await request(app).post(`/api/barters/${barterId}/reject`).set(auth(b.token));
    expect(reject.status).toBe(500);
    expect(reject.body.error).toBe('internal_error');
    const cancel = await request(app).post(`/api/barters/${barterId}/cancel`).set(auth(a.token));
    expect(cancel.status).toBe(500);
    // Rollback de verdade: nem o status nem a torna mudaram.
    const still = await request(app).get(`/api/barters/${barterId}`).set(auth(a.token));
    expect(still.body).toMatchObject({ status: 'proposed', tornaStatus: 'held' });

    // Com o retido de volta, a recusa passa e devolve a torna.
    await pool.query('UPDATE wallets SET balance_pending = 100 WHERE user_id = ?', [a.id]);
    await request(app).post(`/api/barters/${barterId}/reject`).set(auth(b.token)).expect(204);
    expect(await wallet(a.token)).toMatchObject({ balance: 100, balancePending: 0 });
  });

  it('carteira inconsistente na liquidação: os contratos concluem e a troca fica ativa com a torna retida', async () => {
    const a = await registerAndLogin('freelancer');
    const b = await registerAndLogin('freelancer');
    await fundWallet(app, a.token, 100);
    const created = await propose(a, b, 300, 400);
    expect(created.status).toBe(201);
    const barterId = created.body.id as number;
    const accepted = await request(app).post(`/api/barters/${barterId}/accept`).set(auth(b.token));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    await pool.query('UPDATE wallets SET balance_pending = 0 WHERE user_id = ?', [a.id]);
    await completeLinked(accepted.body.contractOfferedId as number, a, b);
    await completeLinked(accepted.body.contractRequestedId as number, b, a);

    // A conclusão gravada dentro da transação foi desfeita: nada de 'completed' sem liquidação.
    const after = await request(app).get(`/api/barters/${barterId}`).set(auth(a.token));
    expect(after.body).toMatchObject({ status: 'active', tornaStatus: 'held' });
    expect(await wallet(b.token)).toMatchObject({ balance: 0, balancePending: 0 });
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
