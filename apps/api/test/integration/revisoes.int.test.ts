import type { ContractWithHistory } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { milestonesRepository } from '../../src/modules/contracts/milestones.repository';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { deleteUsersWithoutLedger } from './helpers/ledger-cleanup';

const app = createApp();
const NOW = new Date('2026-10-08T15:00:00Z');
const ownedContracts: number[] = [];
const ownedUsers: number[] = [];
const ownedBarters: number[] = [];
const originals = new Map<string, string | null>();
interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_verified_at)
      VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo', NOW())`,
    { key, email: `revision-${key}@escambo.test`, role },
  );
  ownedUsers.push(created.insertId);
  await walletRepository.ensure(created.insertId);
  await pool.query(
    'UPDATE wallets SET balance = 5000, credits_balance = 5000 WHERE user_id = :id',
    { id: created.insertId },
  );
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function parties() {
  return { client: await actor('client'), freelancer: await actor('freelancer') };
}
async function detail(id: number, a: Actor): Promise<ContractWithHistory> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(a));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractWithHistory;
}
async function create(
  client: Actor,
  freelancer: Actor,
  mode: 'cash' | 'credits' = 'cash',
  milestones = false,
) {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title: 'Revisões RN-023',
      description: 'Entrega independente para verificar revisões sem custo',
      price: 100,
      paymentMode: mode,
      ...(milestones
        ? {
            milestones: [
              { title: 'Primeira parte', amount: 40 },
              { title: 'Segunda parte', amount: 60 },
            ],
          }
        : {}),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.id as number;
  ownedContracts.push(id);
  expect((await detail(id, client)).revisions).toEqual(milestones ? null : { used: 0, limit: 2 });
  const accepted = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer));
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return id;
}
const deliver = (id: number, a: Actor, mid?: number) =>
  request(app)
    .post(mid ? `/api/contracts/${id}/milestones/${mid}/deliver` : `/api/contracts/${id}/deliver`)
    .set(auth(a))
    .send({ message: 'Versão entregue para conferir o resultado' });
const revision = (id: number, a: Actor, mid?: number) =>
  request(app)
    .post(
      mid
        ? `/api/contracts/${id}/milestones/${mid}/request-revision`
        : `/api/contracts/${id}/request-revision`,
    )
    .set(auth(a))
    .send({ note: 'Ajuste solicitado pelo cliente para a próxima versão' });
const grant = (id: number, a: Actor, mid?: number) =>
  request(app)
    .post(
      mid
        ? `/api/contracts/${id}/milestones/${mid}/revisions/grant`
        : `/api/contracts/${id}/revisions/grant`,
    )
    .set(auth(a));
async function delivered(id: number, a: Actor, mid?: number) {
  const res = await deliver(id, a, mid);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function revised(id: number, a: Actor, mid?: number) {
  const res = await revision(id, a, mid);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function contractRow(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM contracts WHERE id = :id', {
    id,
  });
  return rows[0]!;
}
async function milestoneRow(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM contract_milestones WHERE id = :id',
    { id },
  );
  return rows[0]!;
}
async function historyCount(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM contract_status_history WHERE contract_id = :id',
    { id },
  );
  return Number(rows[0]!.n);
}
async function money(client: Actor, freelancer: Actor, id: number) {
  const [wallets] = await pool.query<RowDataPacket[]>(
    'SELECT user_id, balance, balance_pending, credits_balance, credits_pending FROM wallets WHERE user_id IN (:client, :freelancer) ORDER BY user_id',
    { client: client.id, freelancer: freelancer.id },
  );
  const [cash] = await pool.query<RowDataPacket[]>(
    'SELECT user_id, amount, pending_delta, reason FROM wallet_transactions WHERE contract_id = :id ORDER BY id',
    { id },
  );
  const [credits] = await pool.query<RowDataPacket[]>(
    'SELECT user_id, amount, reason FROM credit_transactions WHERE contract_id = :id ORDER BY id',
    { id },
  );
  return { wallets, cash, credits };
}

/** Ações só são liberadas depois de ambas aguardarem a contratação no InnoDB. */
async function race(
  id: number,
  first: () => PromiseLike<unknown>,
  second: () => PromiseLike<unknown>,
) {
  const blocker = await pool.getConnection();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM contracts WHERE id = :id FOR UPDATE', { id });
    pending = Promise.allSettled([Promise.resolve(first()), Promise.resolve(second())]);
    let waiting = 0;
    const until = Date.now() + 5000;
    while (waiting < 2 && Date.now() < until) {
      const [rows] = await pool.query<
        RowDataPacket[]
      >(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'contracts'`);
      waiting = Number(rows[0]!.n);
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      waiting,
      'os dois pedidos chegaram à fila da trava da contratação',
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await blocker.rollback();
    blocker.release();
    if (pending) await pending;
  }
  const settled = await pending!;
  expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  return settled.map(
    (r) => (r as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>).value,
  );
}

async function legacy(client: Actor, freelancer: Actor, byMilestone: boolean) {
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts
    (ulid, client_id, freelancer_id, title, description, price, platform_fee, freelancer_net, status, payment_mode, revision_limit, revisions_used, accepted_at, created_at)
    VALUES (:key, :client, :freelancer, 'Entrega legada ilimitada', 'Contrato anterior ao limite de revisões', 100, 15, 85, 'accepted', 'cash', NULL, 0, :now, :now)`,
    { key: ulid(), client: client.id, freelancer: freelancer.id, now: NOW },
  );
  const id = created.insertId;
  ownedContracts.push(id);
  let mid: number | undefined;
  if (byMilestone) {
    const [createdMilestone] = await pool.query<ResultSetHeader>(
      `INSERT INTO contract_milestones
      (contract_id, title, amount, freelancer_net, sort_order, status, revision_limit, revisions_used)
      VALUES (:id, 'Marco legado', 100, 85, 0, 'funded', NULL, 0)`,
      { id },
    );
    mid = createdMilestone.insertId;
  }
  return { id, mid };
}

beforeAll(async () => {
  for (const key of ['platform_fee_percentage', 'tacit_approval_days'])
    originals.set(key, await settingsRepository.get(key));
  await settingsRepository.set('platform_fee_percentage', '15', 'integer');
  await settingsRepository.set('tacit_approval_days', '3', 'integer');
  settingsService.clearCache();
});
beforeEach(() => setClockForTests(NOW, { frozen: true }));
afterEach(async () => {
  if (ownedContracts.length)
    await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: ownedContracts });
  if (ownedBarters.length)
    await pool.query('DELETE FROM barter_agreements WHERE id IN (:ids)', { ids: ownedBarters });
  if (ownedUsers.length) {
    await pool.query('DELETE FROM notifications WHERE user_id IN (:ids)', { ids: ownedUsers });
    // Extrato imutável (RNF-036): quem tem lançamento fica, com os lançamentos.
    await deleteUsersWithoutLedger(ownedUsers);
  }
  ownedContracts.length = ownedBarters.length = ownedUsers.length = 0;
});
afterAll(async () => {
  setClockForTests(null);
  for (const [key, value] of originals)
    if (value !== null) await settingsRepository.set(key, value, 'integer');
  settingsService.clearCache();
  await pool.end();
});

describe('RN-023: revisões incluídas e liberação na mesma transação', () => {
  it.each(['cash', 'credits'] as const)(
    'duas revisões, liberação da terceira e novo limite em %s sem mover o escrow',
    async (mode) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, mode);
      const financial = await money(client, freelancer, id);
      for (let used = 1; used <= 2; used++) {
        await delivered(id, freelancer);
        await revised(id, client);
        expect((await detail(id, client)).revisions).toEqual({ used, limit: 2 });
      }
      await delivered(id, freelancer);
      const before = await contractRow(id);
      const count = await historyCount(id);
      const blocked = await revision(id, client);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('revision_limit');
      expect(await historyCount(id)).toBe(count);
      expect((await grant(id, client)).status).toBe(403);
      const granted = await grant(id, freelancer);
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      expect((await detail(id, client)).revisions).toEqual({ used: 2, limit: 3 });
      expect((await contractRow(id)).approval_due_at).toEqual(before.approval_due_at);
      expect((await contractRow(id)).first_delivery_at).toEqual(before.first_delivery_at);
      expect(await historyCount(id)).toBe(count + 1);
      await revised(id, client);
      await delivered(id, freelancer);
      const fourth = await revision(id, client);
      expect(fourth.status).toBe(409);
      expect(fourth.body.error).toBe('revision_limit');
      expect((await detail(id, client)).revisions).toEqual({ used: 3, limit: 3 });
      expect(await money(client, freelancer, id)).toEqual(financial);
    },
  );

  it.each(['cash', 'credits'] as const)(
    'cada marco mantém as próprias revisões em %s',
    async (mode) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, mode, true);
      const [first, second] = (await detail(id, client)).milestones;
      expect([first!.revisions, second!.revisions]).toEqual([
        { used: 0, limit: 2 },
        { used: 0, limit: 2 },
      ]);
      for (let used = 1; used <= 2; used++) {
        await delivered(id, freelancer, first!.id);
        await revised(id, client, first!.id);
      }
      await delivered(id, freelancer, first!.id);
      expect((await revision(id, client, first!.id)).body.error).toBe('revision_limit');
      await delivered(id, freelancer, second!.id);
      await revised(id, client, second!.id);
      const before = await milestoneRow(first!.id);
      expect((await grant(id, freelancer, first!.id)).status).toBe(200);
      const after = await detail(id, client);
      expect(after.milestones.map((m) => m.revisions)).toEqual([
        { used: 2, limit: 3 },
        { used: 1, limit: 2 },
      ]);
      expect((await milestoneRow(first!.id)).approval_due_at).toEqual(before.approval_due_at);
      expect(after.revisions).toBeNull();
    },
  );

  it.each([false, true])(
    'duas revisões simultâneas só consomem uma vaga (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, 'cash', byMilestone);
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      await delivered(id, freelancer, mid);
      await revised(id, client, mid);
      await delivered(id, freelancer, mid);
      const count = await historyCount(id);
      const result = await race(
        id,
        () => revision(id, client, mid),
        () => revision(id, client, mid),
      );
      expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
      const saved = mid ? await milestoneRow(mid) : await contractRow(id);
      expect(saved.revisions_used).toBe(2);
      expect(saved.revision_limit).toBe(2);
      expect(await historyCount(id)).toBe(count + 1);
    },
  );

  it.each([false, true])(
    'duas liberações simultâneas acrescentam só uma revisão (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, 'cash', byMilestone);
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      await delivered(id, freelancer, mid);
      for (let n = 0; n < 2; n++) {
        await revised(id, client, mid);
        await delivered(id, freelancer, mid);
      }
      const before = mid ? await milestoneRow(mid) : await contractRow(id);
      const count = await historyCount(id);
      const result = await race(
        id,
        () => grant(id, freelancer, mid),
        () => grant(id, freelancer, mid),
      );
      expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(result.find((r) => r.status === 409)!.body.error).toBe('revision_grant_not_needed');
      const after = mid ? await milestoneRow(mid) : await contractRow(id);
      expect(after.revision_limit).toBe(3);
      expect(after.revisions_used).toBe(2);
      expect(after.approval_due_at).toEqual(before.approval_due_at);
      expect(await historyCount(id)).toBe(count + 1);
    },
  );

  it.each([false, true])(
    'liberação exige esgotar as revisões incluídas e preserva dinheiro e histórico (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, 'cash', byMilestone);
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      for (let used = 0; used < 2; used++) {
        await delivered(id, freelancer, mid);
        const before = mid ? await milestoneRow(mid) : await contractRow(id);
        const count = await historyCount(id);
        const financial = await money(client, freelancer, id);
        const result = await grant(id, freelancer, mid);
        expect(result.status, JSON.stringify(result.body)).toBe(409);
        expect(result.body.error).toBe('revision_grant_not_needed');
        expect(mid ? await milestoneRow(mid) : await contractRow(id)).toEqual(before);
        expect(before).toMatchObject({ revisions_used: used, revision_limit: 2 });
        expect(await historyCount(id)).toBe(count);
        expect(await money(client, freelancer, id)).toEqual(financial);
        await revised(id, client, mid);
      }
    },
  );

  it.each([false, true])(
    'legado NULL permite cinco revisões e a revisão 256 (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const { id, mid } = await legacy(client, freelancer, byMilestone);
      for (let n = 0; n < 5; n++) {
        await delivered(id, freelancer, mid);
        await revised(id, client, mid);
      }
      expect(mid ? await milestoneRow(mid) : await contractRow(id)).toMatchObject({
        revisions_used: 5,
        revision_limit: null,
      });
      await delivered(id, freelancer, mid);
      expect((await grant(id, freelancer, mid)).body.error).toBe('revision_unlimited');
      await pool.query(
        mid
          ? 'UPDATE contract_milestones SET revisions_used = 255 WHERE id = :id'
          : 'UPDATE contracts SET revisions_used = 255 WHERE id = :id',
        { id: mid ?? id },
      );
      await revised(id, client, mid);
      expect(mid ? await milestoneRow(mid) : await contractRow(id)).toMatchObject({
        revisions_used: 256,
        revision_limit: null,
      });
    },
  );

  it.each([false, true])(
    'liberação antiga não aumenta o limite após liberação, consumo e reentrega (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, 'cash', byMilestone);
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      await delivered(id, freelancer, mid);
      for (let n = 0; n < 2; n++) {
        await revised(id, client, mid);
        await delivered(id, freelancer, mid);
      }
      const stale = mid ? await milestoneRow(mid) : await contractRow(id);
      expect(stale).toMatchObject({ revisions_used: 2, revision_limit: 2 });
      expect((await grant(id, freelancer, mid)).status).toBe(200);
      await revised(id, client, mid);
      await delivered(id, freelancer, mid);
      const before = mid ? await milestoneRow(mid) : await contractRow(id);
      const count = await historyCount(id);
      const financial = await money(client, freelancer, id);
      const budget = {
        changedBy: freelancer.id,
        source: 'user' as const,
        now: NOW,
        expectedRevisionsUsed: Number(stale.revisions_used),
        expectedRevisionLimit: Number(stale.revision_limit),
      };
      const result = mid
        ? await milestonesRepository.grantRevision({ contractId: id, milestoneId: mid, ...budget })
        : await contractsRepository.grantRevision({ id, ...budget });
      expect(result).toBe(false);
      expect(mid ? await milestoneRow(mid) : await contractRow(id)).toEqual(before);
      expect(before).toMatchObject({ revisions_used: 3, revision_limit: 3 });
      expect(await historyCount(id)).toBe(count);
      expect(await money(client, freelancer, id)).toEqual(financial);
    },
  );

  it('pedido antigo do marco não consome outra revisão após a primeira revisão e reentrega', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer, 'cash', true);
    const mid = (await detail(id, client)).milestones[0]!.id;
    await delivered(id, freelancer, mid);
    const stale = await milestoneRow(mid);
    expect(stale.revisions_used).toBe(0);
    await revised(id, client, mid);
    await delivered(id, freelancer, mid);
    const before = await milestoneRow(mid);
    const count = await historyCount(id);
    const financial = await money(client, freelancer, id);
    expect(
      await milestonesRepository.requestRevision({
        contractId: id,
        milestoneId: mid,
        changedBy: client.id,
        source: 'user',
        note: 'Pedido feito antes da primeira revisão',
        now: NOW,
        expectedRevisionsUsed: Number(stale.revisions_used),
      }),
    ).toBe(false);
    expect(await milestoneRow(mid)).toEqual(before);
    expect(before).toMatchObject({ status: 'delivered', revisions_used: 1, revision_limit: 2 });
    expect(await historyCount(id)).toBe(count);
    expect(await money(client, freelancer, id)).toEqual(financial);
  });

  it.each([false, true])(
    'liberação atravessa 255→256 sem alterar a tácita (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, 'cash', byMilestone);
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      await delivered(id, freelancer, mid);
      await pool.query(
        mid
          ? 'UPDATE contract_milestones SET revisions_used = 255, revision_limit = 255 WHERE id = :id'
          : 'UPDATE contracts SET revisions_used = 255, revision_limit = 255 WHERE id = :id',
        { id: mid ?? id },
      );
      const before = mid ? await milestoneRow(mid) : await contractRow(id);
      expect((await grant(id, freelancer, mid)).status).toBe(200);
      expect(mid ? await milestoneRow(mid) : await contractRow(id)).toMatchObject({
        revisions_used: 255,
        revision_limit: 256,
        approval_due_at: before.approval_due_at,
      });
      await revised(id, client, mid);
      expect((mid ? await milestoneRow(mid) : await contractRow(id)).revisions_used).toBe(256);
    },
  );

  it('o aviso da última revisão incluída identifica revisão 2 de 2', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    for (let n = 0; n < 2; n++) {
      await delivered(id, freelancer);
      await revised(id, client);
    }
    let body = '';
    const until = Date.now() + 5000;
    while (!body.includes('Revisão 2 de 2') && Date.now() < until) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT body FROM notifications WHERE user_id = :user AND type = 'contract_revision'
        AND JSON_EXTRACT(data, '$.contractId') = :id ORDER BY id DESC LIMIT 1`,
        { user: freelancer.id, id },
      );
      body = String(rows[0]?.body ?? '');
      if (!body.includes('Revisão 2 de 2')) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(body).toContain('Revisão 2 de 2 sem custo, a última incluída');
  });

  it('os dois contratos novos de uma troca também incluem duas revisões', async () => {
    const a = await actor('freelancer');
    const b = await actor('freelancer');
    const proposed = await request(app).post('/api/barters').set(auth(a)).send({
      receiverId: b.id,
      offeredDescription: 'Serviço oferecido',
      requestedDescription: 'Serviço solicitado',
      estimatedValueOffered: 100,
      estimatedValueRequested: 100,
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    ownedBarters.push(proposed.body.id as number);
    const accepted = await request(app)
      .post(`/api/barters/${proposed.body.id}/accept`)
      .set(auth(b));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const [agreements] = await pool.query<RowDataPacket[]>(
      'SELECT contract_offered_id, contract_requested_id FROM barter_agreements WHERE id = :id',
      { id: proposed.body.id },
    );
    const offered = Number(agreements[0]!.contract_offered_id);
    const requested = Number(agreements[0]!.contract_requested_id);
    ownedContracts.push(offered, requested);
    expect((await detail(offered, a)).revisions).toEqual({ used: 0, limit: 2 });
    expect((await detail(requested, b)).revisions).toEqual({ used: 0, limit: 2 });
    for (let n = 0; n < 2; n++) {
      await delivered(offered, a);
      await revised(offered, b);
    }
    await delivered(offered, a);
    expect((await revision(offered, b)).body.error).toBe('revision_limit');
  });
});
