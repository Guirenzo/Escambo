import type { ContractWithHistory } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { contractsService } from '../../src/modules/contracts/contracts.service';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';

const app = createApp();
const NOW = new Date('2026-10-08T15:00:00Z');
interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
let originalFee: string | null;

async function actor(role: 'client' | 'freelancer', cash = 600, credits = 100): Promise<Actor> {
  const key = ulid();
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone) VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo')`,
    { key, email: `negotiation-${key}@escambo.test`, role },
  );
  await walletRepository.ensure(res.insertId);
  await pool.query(
    'UPDATE wallets SET balance = :cash, credits_balance = :credits WHERE user_id = :id',
    { id: res.insertId, cash, credits },
  );
  return {
    id: res.insertId,
    token: jwt.sign({ sub: key, uid: res.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}
async function parties(cash = 600) {
  return { client: await actor('client', cash), freelancer: await actor('freelancer', 0, 0) };
}
async function create(
  client: Actor,
  freelancer: Actor,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title: 'Negociação fictícia RN-030',
      description: 'Termos financeiros e datas da negociação de teste',
      price: 100,
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}
async function detail(id: number, a: Actor): Promise<ContractWithHistory> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(a));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractWithHistory;
}
const counter = (
  id: number,
  a: Actor,
  seq: number,
  price: number,
  extra: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/contracts/${id}/offers`)
    .set(auth(a))
    .send({
      seq,
      price,
      deadlineAt: null,
      message: `Novos termos para a oferta ${seq + 1}`,
      ...extra,
    });
async function balance(a: Actor) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT balance, balance_pending, credits_balance, credits_pending FROM wallets WHERE user_id = :id',
    { id: a.id },
  );
  const r = rows[0]!;
  return {
    cash: Number(r.balance),
    pending: Number(r.balance_pending),
    credits: Number(r.credits_balance),
    creditsPending: Number(r.credits_pending),
  };
}
async function ledger(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT user_id, amount, pending_delta, reason FROM wallet_transactions WHERE contract_id = :id ORDER BY id',
    { id },
  );
  return rows.map((r) => ({
    user: r.user_id as number,
    amount: Number(r.amount),
    pending: Number(r.pending_delta),
    reason: r.reason as string,
  }));
}

/** As duas ações leem a mesma oferta e chegam de fato à fila da trava do contrato. */
async function race(
  id: number,
  first: () => PromiseLike<unknown>,
  second: () => PromiseLike<unknown>,
  beforeRelease?: () => Promise<unknown>,
) {
  const blocker = await pool.getConnection();
  let work: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM contracts WHERE id = :id FOR UPDATE', { id });
    work = Promise.allSettled([Promise.resolve(first()), Promise.resolve(second())]);
    let waiting = 0;
    const until = Date.now() + 5000;
    while (waiting < 2 && Date.now() < until) {
      const [rows] = await pool.query<
        RowDataPacket[]
      >(`SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'contracts'`);
      waiting = Number(rows[0]!.waiting);
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting, 'ambas as ações aguardam a mesma contratação no InnoDB').toBeGreaterThanOrEqual(
      2,
    );
    if (beforeRelease) await beforeRelease();
  } finally {
    await blocker.rollback();
    blocker.release();
    if (work) await work;
  }
  const [mismatches] = await pool.query<RowDataPacket[]>(
    `SELECT c.id, c.status, c.price, COALESCE(SUM(t.pending_delta), 0) AS held
       FROM contracts c LEFT JOIN wallet_transactions t
         ON t.contract_id = c.id AND t.user_id = c.client_id
      WHERE c.id = :id AND c.payment_mode = 'cash' AND c.barter_agreement_id IS NULL
      GROUP BY c.id, c.status, c.price
      HAVING held <> IF(c.status = 'pending', c.price, 0)`,
    { id },
  );
  expect(mismatches, 'reserva do cliente confere com o preço após cada corrida').toEqual([]);
  return work!;
}

beforeAll(async () => {
  setClockForTests(NOW, { frozen: true });
  originalFee = await settingsRepository.get('platform_fee_percentage');
  await settingsRepository.set('platform_fee_percentage', '15', 'integer');
  settingsService.clearCache();
});
afterAll(async () => {
  setClockForTests(null);
  if (originalFee !== null)
    await settingsRepository.set('platform_fee_percentage', originalFee, 'integer');
  settingsService.clearCache();
  await pool.end();
});

describe('RN-030: cinco ofertas, reserva e aceite atômico', () => {
  it.each([
    { mode: 'cash', initial: 100, offered: 120, fee: 18, net: 102 },
    { mode: 'credits', initial: 30, offered: 35, fee: 0, net: 35 },
  ])(
    'cliente aceita contraproposta em $mode de freelancer pending_verification e financia só os termos aceitos',
    async ({ mode, initial, offered, fee, net }) => {
      const { client, freelancer } = await parties();
      await pool.query("UPDATE users SET status = 'pending_verification' WHERE id = :id", {
        id: freelancer.id,
      });
      const id = await create(client, freelancer, { paymentMode: mode, price: initial });
      const proposed = await counter(id, freelancer, 1, offered);
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      expect(await balance(client)).toMatchObject(
        mode === 'cash'
          ? { cash: 500, pending: 100, credits: 100, creditsPending: 0 }
          : { cash: 600, pending: 0, credits: 100, creditsPending: 0 },
      );
      const accepted = await request(app)
        .post(`/api/contracts/${id}/offers/2/accept`)
        .set(auth(client));
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body).toMatchObject({
        status: 'accepted',
        price: offered,
        platformFee: fee,
        freelancerNet: net,
        negotiation: null,
      });
      expect((await detail(id, client)).offers?.map((o) => [o.seq, o.price, o.outcome])).toEqual([
        [1, initial, 'countered'],
        [2, offered, 'accepted'],
      ]);
      expect(await balance(client)).toEqual(
        mode === 'cash'
          ? { cash: 480, pending: 0, credits: 100, creditsPending: 0 }
          : { cash: 600, pending: 0, credits: 65, creditsPending: 0 },
      );
      expect(await balance(freelancer)).toEqual(
        mode === 'cash'
          ? { cash: 0, pending: 102, credits: 0, creditsPending: 0 }
          : { cash: 0, pending: 0, credits: 0, creditsPending: 35 },
      );
      if (mode === 'cash') {
        expect(await ledger(id)).toEqual([
          { user: client.id, amount: -100, pending: 100, reason: 'hold' },
          { user: client.id, amount: -20, pending: 20, reason: 'hold' },
          { user: client.id, amount: 0, pending: -120, reason: 'payment' },
          { user: freelancer.id, amount: 0, pending: 102, reason: 'escrow_in' },
        ]);
      } else {
        expect(await ledger(id)).toEqual([]);
        const [credits] = await pool.query<RowDataPacket[]>(
          'SELECT user_id, amount, reason FROM credit_transactions WHERE contract_id = :id ORDER BY id',
          { id },
        );
        expect(credits.map((r) => [r.user_id, Number(r.amount), r.reason])).toEqual([
          [client.id, -35, 'escrow_hold'],
          [freelancer.id, 35, 'escrow_in'],
        ]);
      }
      const [users] = await pool.query<RowDataPacket[]>('SELECT status FROM users WHERE id = :id', {
        id: freelancer.id,
      });
      expect(users[0]!.status).toBe('pending_verification');
    },
  );

  it('a validade que termina enquanto se espera a trava impede aceite e contraproposta, sem mover dinheiro', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    expect((await counter(id, freelancer, 1, 120)).status).toBe(201);
    const current = await detail(id, client);
    try {
      const result = await race(
        id,
        () => contractsService.acceptCounter(id, client.id, 2),
        () =>
          contractsService.counter(id, client.id, {
            seq: 2,
            price: 90,
            deadlineAt: null,
            message: 'Oferta enviada antes de vencer',
          }),
        async () => {
          setClockForTests(new Date(Date.parse(current.negotiation!.respondBy!) + 1000), {
            frozen: true,
          });
        },
      );
      expect(result.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(result.map((r) => (r as PromiseRejectedResult).reason.statusCode)).toEqual([409, 409]);
      expect(await detail(id, client)).toMatchObject({
        status: 'pending',
        price: 100,
        negotiation: { seq: 2, current: { outcome: 'open' } },
      });
      expect(await balance(client)).toMatchObject({ cash: 500, pending: 100 });
      expect(await balance(freelancer)).toMatchObject({ pending: 0 });
      expect(await ledger(id)).toHaveLength(1);
    } finally {
      setClockForTests(NOW, { frozen: true });
    }
  });
  it('freelancer bloqueado enquanto os aceites aguardam a trava não inicia o contrato nem move dinheiro', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    expect((await counter(id, freelancer, 1, 120)).status).toBe(201);
    const result = await race(
      id,
      () => contractsService.acceptCounter(id, client.id, 2),
      () => contractsService.acceptCounter(id, client.id, 2),
      () => pool.query("UPDATE users SET status = 'banned' WHERE id = :id", { id: freelancer.id }),
    );
    expect(result.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(result.map((r) => (r as PromiseRejectedResult).reason.code)).toEqual([
      'freelancer_unavailable',
      'freelancer_unavailable',
    ]);
    expect(await detail(id, client)).toMatchObject({
      status: 'pending',
      price: 100,
      negotiation: { seq: 2, current: { outcome: 'open' } },
    });
    expect(await balance(client)).toMatchObject({ cash: 500, pending: 100 });
    expect(await balance(freelancer)).toMatchObject({ pending: 0 });
    expect(await ledger(id)).toHaveLength(1);
  });
  it('cinco ofertas preservam taxa histórica, guardam o histórico e só a última proposta do cliente ajusta a reserva', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    expect((await detail(id, client)).offers).toHaveLength(1);
    await settingsRepository.set('platform_fee_percentage', '23', 'integer');
    settingsService.clearCache();
    try {
      for (const [seq, price] of [
        [1, 120],
        [2, 90],
        [3, 110],
        [4, 80],
      ]) {
        const res = await counter(id, seq! % 2 ? freelancer : client, seq!, price!);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.negotiation).toMatchObject({ seq: seq! + 1, feePercentage: 15 });
        expect(res.body.price).toBe(seq! < 2 ? 100 : seq! < 4 ? 90 : 80);
      }
      const final = await detail(id, freelancer);
      expect(final.negotiation).toMatchObject({
        seq: 5,
        round: 3,
        turn: 'freelancer',
        canCounter: false,
      });
      expect(final.offers?.map((o) => [o.seq, o.price, o.outcome])).toEqual([
        [1, 100, 'countered'],
        [2, 120, 'countered'],
        [3, 90, 'countered'],
        [4, 110, 'countered'],
        [5, 80, 'open'],
      ]);
      const stale = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer));
      expect(stale.status).toBe(409);
      const accepted = await request(app)
        .post(`/api/contracts/${id}/accept`)
        .set(auth(freelancer))
        .send({ seq: 5 });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body).toMatchObject({
        status: 'accepted',
        price: 80,
        platformFee: 12,
        freelancerNet: 68,
        negotiation: null,
      });
      expect(await balance(client)).toMatchObject({ cash: 520, pending: 0 });
      expect(await balance(freelancer)).toMatchObject({ cash: 0, pending: 68 });
      expect((await ledger(id)).filter((r) => r.user === client.id)).toEqual([
        { user: client.id, amount: -100, pending: 100, reason: 'hold' },
        { user: client.id, amount: 10, pending: -10, reason: 'hold_release' },
        { user: client.id, amount: 10, pending: -10, reason: 'hold_release' },
        { user: client.id, amount: 0, pending: -80, reason: 'payment' },
      ]);
      expect((await detail(id, client)).offers?.at(-1)?.outcome).toBe('accepted');
    } finally {
      await settingsRepository.set('platform_fee_percentage', '15', 'integer');
      settingsService.clearCache();
    }
  });

  it.each([120, 80])(
    'aceite da oferta par de %s ajusta somente a diferença e financia os marcos sem trocar seus IDs',
    async (price) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, {
        milestones: [
          { title: 'Layout', amount: 40 },
          { title: 'Entrega', amount: 60 },
        ],
      });
      const initial = await detail(id, client);
      const res = await counter(id, freelancer, 1, price, {
        milestones: initial.milestones.map((m, i) => ({
          id: m.id,
          amount: i === 0 ? price * 0.4 : price * 0.6,
          dueAt: null,
        })),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await balance(client)).toMatchObject({ cash: 500, pending: 100 });
      expect((await detail(id, client)).milestones.map((m) => m.amount)).toEqual([40, 60]);
      const accepted = await request(app)
        .post(`/api/contracts/${id}/offers/2/accept`)
        .set(auth(client));
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.milestones.map((m: { id: number }) => m.id)).toEqual(
        initial.milestones.map((m) => m.id),
      );
      expect(accepted.body.milestones.every((m: { status: string }) => m.status === 'funded')).toBe(
        true,
      );
      expect(accepted.body.milestones.map((m: { amount: number }) => m.amount)).toEqual([
        price * 0.4,
        price * 0.6,
      ]);
      expect(await balance(client)).toMatchObject({ cash: 600 - price, pending: 0 });
      expect(await balance(freelancer)).toMatchObject({ pending: price * 0.85 });
      const rows = (await ledger(id)).filter((r) => r.user === client.id);
      expect(rows.map((r) => r.reason)).toEqual([
        'hold',
        price > 100 ? 'hold' : 'hold_release',
        'payment',
      ]);
      expect(rows.reduce((sum, r) => sum + r.pending, 0)).toBe(0);
    },
  );

  it('saldo insuficiente no aceite desfaz oferta, marcos, reserva e extrato; depósito permite tentar a mesma oferta', async () => {
    const { client, freelancer } = await parties(100);
    const id = await create(client, freelancer);
    expect((await counter(id, freelancer, 1, 120)).status).toBe(201);
    const failed = await request(app)
      .post(`/api/contracts/${id}/offers/2/accept`)
      .set(auth(client));
    expect(failed.status, JSON.stringify(failed.body)).toBe(402);
    expect(failed.body.error).toBe('insufficient_balance');
    expect(await detail(id, client)).toMatchObject({
      status: 'pending',
      price: 100,
      negotiation: { seq: 2, current: { outcome: 'open' } },
    });
    expect(await balance(client)).toMatchObject({ cash: 0, pending: 100 });
    expect(await balance(freelancer)).toMatchObject({ pending: 0 });
    expect(await ledger(id)).toHaveLength(1);
    const failedCounter = await counter(id, client, 2, 130);
    expect(failedCounter.status).toBe(402);
    expect((await detail(id, client)).offers).toHaveLength(2);
    await pool.query('UPDATE wallets SET balance = 20 WHERE user_id = :id', { id: client.id });
    const accepted = await request(app)
      .post(`/api/contracts/${id}/offers/2/accept`)
      .set(auth(client));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await balance(client)).toMatchObject({ cash: 0, pending: 0 });
    expect(await balance(freelancer)).toMatchObject({ pending: 102 });
  });

  it('créditos inteiros não são reservados na negociação e só o valor aceito entra em escrow', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer, { paymentMode: 'credits', price: 30 });
    expect((await counter(id, freelancer, 1, 35)).status).toBe(201);
    expect(await balance(client)).toMatchObject({ credits: 100, creditsPending: 0, pending: 0 });
    expect((await counter(id, client, 2, 32.5)).status).toBe(422);
    const accepted = await request(app)
      .post(`/api/contracts/${id}/offers/2/accept`)
      .set(auth(client));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ price: 35, platformFee: 0, freelancerNet: 35 });
    expect(await balance(client)).toMatchObject({ cash: 600, pending: 0, credits: 65 });
    expect(await balance(freelancer)).toMatchObject({ credits: 0, creditsPending: 35 });
    expect(await ledger(id)).toEqual([]);
    const [credits] = await pool.query<RowDataPacket[]>(
      'SELECT amount, reason FROM credit_transactions WHERE contract_id = :id ORDER BY id',
      { id },
    );
    expect(credits.map((r) => [Number(r.amount), r.reason])).toEqual([
      [-35, 'escrow_hold'],
      [35, 'escrow_in'],
    ]);
  });

  it('a recusa e o cancelamento da oferta par devolvem o preço reservado, sem financiar a oferta do freelancer', async () => {
    for (const action of ['reject', 'cancel']) {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer);
      expect((await counter(id, freelancer, 1, 150)).status).toBe(201);
      const closed = await request(app)
        .post(`/api/contracts/${id}/${action}`)
        .set(auth(action === 'reject' ? freelancer : client))
        .send({ seq: 2 });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(await balance(client)).toMatchObject({ cash: 600, pending: 0 });
      expect(await balance(freelancer)).toMatchObject({ pending: 0 });
      expect((await detail(id, client)).offers?.at(-1)?.outcome).toBe(
        action === 'reject' ? 'withdrawn' : 'declined',
      );
      const again = await request(app)
        .post(`/api/contracts/${id}/${action}`)
        .set(auth(action === 'reject' ? freelancer : client))
        .send({ seq: 2 });
      expect(again.status).toBe(409);
      expect((await ledger(id)).filter((r) => r.reason === 'refund')).toHaveLength(1);
    }
  });

  it('oferta legada sem snapshot é copiada antes da contraproposta, sem recalcular seus centavos com a taxa atual', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer, { price: 10.01 });
    await pool.query('DELETE FROM contract_offers WHERE contract_id = :id', { id });
    await pool.query('UPDATE contracts SET fee_percentage = NULL WHERE id = :id', { id });
    const res = await counter(id, freelancer, 1, 12.01);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.offers[0]).toMatchObject({
      price: 10.01,
      platformFee: 1.5,
      freelancerNet: 8.51,
      outcome: 'countered',
    });
    expect(res.body.offers[1]).toMatchObject({
      price: 12.01,
      platformFee: 1.8,
      freelancerNet: 10.21,
    });
    expect(res.body.negotiation.feePercentage).toBe(15);
  });

  it('expiração par usa o fuso do cliente, devolve a reserva uma vez e encerra o snapshot certo', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    expect((await counter(id, freelancer, 1, 150)).status).toBe(201);
    const expired = new Date('2026-10-10T12:00:00Z');
    await pool.query(
      "UPDATE users SET timezone = IF(id = :client, 'America/Noronha', 'America/Rio_Branco') WHERE id IN (:client, :freelancer)",
      { client: client.id, freelancer: freelancer.id },
    );
    await pool.query('UPDATE contracts SET proposal_expires_at = :expired WHERE id = :id', {
      id,
      expired,
    });
    await pool.query(
      'UPDATE contract_offers SET respond_by = :expired WHERE contract_id = :id AND seq = 2',
      { id, expired },
    );
    expect(
      (await contractsRepository.findProposalsDue(expired, ['America/Noronha'])).map((r) => r.id),
    ).toContain(id);
    expect(
      (await contractsRepository.findProposalsDue(expired, ['America/Rio_Branco'])).map(
        (r) => r.id,
      ),
    ).not.toContain(id);
    await contractsService.expireProposal(id, expired);
    expect(await balance(client)).toMatchObject({ cash: 600, pending: 0 });
    expect((await detail(id, client)).offers?.at(-1)?.outcome).toBe('expired');
    await expect(contractsService.expireProposal(id, expired)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await ledger(id)).filter((r) => r.reason === 'refund')).toHaveLength(1);
  });

  it('aceites duplicados e aceite × cancelamento sob uma trava real movem dinheiro uma única vez', async () => {
    for (const duplicate of [true, false]) {
      for (let run = 0; run < 4; run++) {
        const { client, freelancer } = await parties();
        const id = await create(client, freelancer);
        expect((await counter(id, freelancer, 1, 120)).status).toBe(201);
        const result = await race(
          id,
          () => contractsService.acceptCounter(id, client.id, 2),
          () =>
            duplicate
              ? contractsService.acceptCounter(id, client.id, 2)
              : contractsService.cancel(id, client.id, { seq: 2 }),
        );
        expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(
          result
            .filter((r) => r.status === 'rejected')
            .map((r) => (r as PromiseRejectedResult).reason.statusCode),
        ).toEqual([409]);
        const final = await detail(id, client);
        if (final.status === 'accepted') {
          expect(await balance(client)).toMatchObject({ cash: 480, pending: 0 });
          expect(await balance(freelancer)).toMatchObject({ pending: 102 });
        } else {
          expect(final.status).toBe('cancelled');
          expect(await balance(client)).toMatchObject({ cash: 600, pending: 0 });
          expect(await balance(freelancer)).toMatchObject({ pending: 0 });
        }
        expect(
          (await ledger(id)).filter((r) => r.reason === 'payment' || r.reason === 'refund'),
        ).toHaveLength(1);
      }
    }
  });

  it('contraproposta × cancelamento e contraproposta × expiração não deixam a ação da oferta velha atingir a nova', async () => {
    for (const expiry of [false, true]) {
      for (let run = 0; run < 4; run++) {
        const { client, freelancer } = await parties();
        const id = await create(client, freelancer);
        expect((await counter(id, freelancer, 1, 120)).status).toBe(201);
        const current = await detail(id, client);
        const result = await race(
          id,
          () =>
            contractsService.counter(id, client.id, {
              seq: 2,
              price: 90,
              deadlineAt: null,
              message: 'Podemos fechar por noventa',
            }),
          () =>
            expiry
              ? contractsService.expireProposal(id, new Date(current.negotiation!.respondBy!))
              : contractsService.cancel(id, client.id, { seq: 2 }),
        );
        expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(
          result
            .filter((r) => r.status === 'rejected')
            .map((r) => (r as PromiseRejectedResult).reason.statusCode),
        ).toEqual([409]);
        const final = await detail(id, client);
        if (final.status === 'pending') {
          expect(final.negotiation).toMatchObject({
            seq: 3,
            current: { outcome: 'open', price: 90 },
          });
          expect(await balance(client)).toMatchObject({ cash: 510, pending: 90 });
          expect(final.offers).toHaveLength(3);
        } else {
          expect(final.status).toBe('cancelled');
          expect(await balance(client)).toMatchObject({ cash: 600, pending: 0 });
          expect(final.offers).toHaveLength(2);
        }
        expect(await balance(freelancer)).toMatchObject({ pending: 0 });
      }
    }
  });
});
