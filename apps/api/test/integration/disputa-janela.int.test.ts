import type { BrazilTimezone, ContractWithHistory } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { contractsService } from '../../src/modules/contracts/contracts.service';
import { disputesService } from '../../src/modules/disputes/disputes.service';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { deleteUsersWithoutLedger } from './helpers/ledger-cleanup';

const app = createApp();
const NOW = new Date('2026-10-08T15:00:00Z');
const H = 3_600_000;
const ownedUsers: number[] = [];
const ownedContracts: number[] = [];
const originals = new Map<string, string | null>();
interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
const at = (hours: number) => new Date(NOW.getTime() + hours * H);
const clock = (value: Date) => setClockForTests(value, { frozen: true });

async function actor(role: 'client' | 'freelancer', zone: BrazilTimezone): Promise<Actor> {
  const key = ulid();
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_verified_at)
    VALUES (:key, :email, :role, 'active', :zone, NOW())`,
    { key, email: `dispute-window-${key}@escambo.test`, role, zone },
  );
  ownedUsers.push(res.insertId);
  await walletRepository.ensure(res.insertId);
  await pool.query('UPDATE wallets SET balance = 1000 WHERE user_id = :id', { id: res.insertId });
  return {
    id: res.insertId,
    token: jwt.sign({ sub: key, uid: res.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}
async function parties() {
  return {
    client: await actor('client', 'America/Manaus'),
    freelancer: await actor('freelancer', 'America/Sao_Paulo'),
  };
}
async function create(client: Actor, freelancer: Actor, byMilestone = false) {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title: 'Janela manual RN-062',
      description: 'Contrato independente para a janela de conversa antes da disputa',
      price: 100,
      ...(byMilestone
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
  const accepted = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer));
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return id;
}
async function detail(id: number, a: Actor): Promise<ContractWithHistory> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(a));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractWithHistory;
}
async function row(id: number) {
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
const open = (id: number, a: Actor) =>
  request(app).post('/api/disputes').set(auth(a)).send({
    contractId: id,
    reason: 'quality',
    description: 'As partes ainda não resolveram a qualidade da entrega',
  });
async function delivered(id: number, a: Actor, mid?: number) {
  const res = await request(app)
    .post(mid ? `/api/contracts/${id}/milestones/${mid}/deliver` : `/api/contracts/${id}/deliver`)
    .set(auth(a))
    .send({ message: 'Primeira versão ou reentrega para conferir a janela' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function revised(id: number, a: Actor, mid?: number) {
  const res = await request(app)
    .post(
      mid
        ? `/api/contracts/${id}/milestones/${mid}/request-revision`
        : `/api/contracts/${id}/request-revision`,
    )
    .set(auth(a))
    .send({ note: 'Conversemos sobre a revisão desta entrega' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function disputeCount(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM disputes WHERE contract_id = :id',
    { id },
  );
  return Number(rows[0]!.n);
}
async function financial(id: number, client: Actor, freelancer: Actor) {
  const [wallets] = await pool.query<RowDataPacket[]>(
    'SELECT user_id, balance, balance_pending FROM wallets WHERE user_id IN (:client, :freelancer) ORDER BY user_id',
    { client: client.id, freelancer: freelancer.id },
  );
  const [ledger] = await pool.query<RowDataPacket[]>(
    'SELECT user_id, amount, pending_delta, reason FROM wallet_transactions WHERE contract_id = :id ORDER BY id',
    { id },
  );
  return { wallets, ledger };
}

async function race(id: number, first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const blocker = await pool.getConnection();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM contracts WHERE id = :id FOR UPDATE', { id });
    pending = Promise.allSettled([first(), second()]);
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
      'entrega e disputa chegaram à fila da trava real da contratação',
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await blocker.rollback();
    blocker.release();
    if (pending) await pending;
  }
  return pending!;
}

beforeAll(async () => {
  for (const key of ['platform_fee_percentage', 'tacit_approval_days'])
    originals.set(key, await settingsRepository.get(key));
  await settingsRepository.set('platform_fee_percentage', '15', 'integer');
  settingsService.clearCache();
});
beforeEach(async () => {
  clock(NOW);
  await settingsRepository.set('tacit_approval_days', '3', 'integer');
  settingsService.clearCache();
});
afterEach(async () => {
  if (ownedContracts.length) {
    await pool.query('DELETE FROM disputes WHERE contract_id IN (:ids)', { ids: ownedContracts });
    await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: ownedContracts });
  }
  if (ownedUsers.length) {
    await pool.query('DELETE FROM notifications WHERE user_id IN (:ids)', { ids: ownedUsers });
    // Extrato imutável (RNF-036): quem tem lançamento fica, com os lançamentos.
    await deleteUsersWithoutLedger(ownedUsers);
  }
  ownedContracts.length = ownedUsers.length = 0;
});
afterAll(async () => {
  setClockForTests(null);
  for (const [key, value] of originals)
    if (value !== null) await settingsRepository.set(key, value, 'integer');
  settingsService.clearCache();
  await pool.end();
});

describe('RN-062: janela manual e snapshots históricos', () => {
  it.each(['client', 'freelancer'] as const)(
    'sem entrega abre exatamente após 48h do aceite e informa o fuso do %s',
    async (who) => {
      const pair = await parties();
      const id = await create(pair.client, pair.freelancer);
      const opensAt = at(48).toISOString();
      expect((await detail(id, pair[who])).disputeOpensAt).toBe(opensAt);
      const money = await financial(id, pair.client, pair.freelancer);
      clock(new Date(at(48).getTime() - 1000));
      const early = await open(id, pair[who]);
      expect(early.status, JSON.stringify(early.body)).toBe(409);
      expect(early.body).toMatchObject({ error: 'dispute_too_early', opensAt });
      expect(early.body.message).toContain(`10/10 às ${who === 'client' ? '11:00' : '12:00'}`);
      expect((await row(id)).status).toBe('accepted');
      expect(await disputeCount(id)).toBe(0);
      clock(at(48));
      const accepted = await open(id, pair[who]);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      expect((await row(id)).status).toBe('disputed');
      expect(await disputeCount(id)).toBe(1);
      expect(await financial(id, pair.client, pair.freelancer)).toEqual(money);
    },
  );

  it('a primeira entrega inicia as 48h mesmo quando o aceite já era mais antigo', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    clock(at(24));
    await delivered(id, freelancer);
    expect(await row(id)).toMatchObject({
      first_delivery_at: at(24),
      delivery_dispute_opens_at: at(72),
    });
    expect((await detail(id, client)).disputeOpensAt).toBe(at(72).toISOString());
    clock(new Date(at(72).getTime() - 1000));
    expect((await open(id, client)).body.error).toBe('dispute_too_early');
    clock(at(72));
    expect((await open(id, client)).status).toBe(201);
  });

  it('tácita de um dia permite disputa na hora da entrega, preservando 24h antes da aprovação', async () => {
    await settingsRepository.set('tacit_approval_days', '1', 'integer');
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    await delivered(id, freelancer);
    expect(await row(id)).toMatchObject({
      first_delivery_at: NOW,
      approval_due_at: at(24),
      delivery_dispute_opens_at: NOW,
    });
    expect((await detail(id, client)).disputeOpensAt).toBe(NOW.toISOString());
    expect((await open(id, client)).status).toBe(201);
  });

  it.each([false, true])(
    'revisão e reentrega conservam a primeira entrega e a abertura (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, byMilestone);
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      await delivered(id, freelancer, mid);
      expect((await detail(id, client)).disputeOpensAt).toBe(at(48).toISOString());
      clock(at(4));
      await revised(id, client, mid);
      expect((await detail(id, client)).disputeOpensAt).toBe(at(48).toISOString());
      clock(at(50));
      await delivered(id, freelancer, mid);
      expect((await row(id)).first_delivery_at).toEqual(NOW);
      expect((await detail(id, client)).disputeOpensAt).toBe(at(48).toISOString());
      const saved = mid ? await milestoneRow(mid) : await row(id);
      expect(mid ? saved.dispute_opens_at : saved.delivery_dispute_opens_at).toEqual(at(48));
      expect(saved.approval_due_at).toEqual(at(122));
      expect((await open(id, client)).status).toBe(201);
    },
  );

  it.each([false, true])(
    'reentrega antes do job recupera a menor entrega histórica (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, byMilestone);
      const first = at(-120);
      const last = at(-96);
      await pool.query(
        `UPDATE contracts SET status = :status, created_at = :accepted, accepted_at = :accepted,
      first_delivery_at = NULL, delivery_dispute_opens_at = NULL, approval_due_at = NULL WHERE id = :id`,
        { id, status: byMilestone ? 'in_progress' : 'revision_requested', accepted: at(-144) },
      );
      let mid: number | undefined;
      if (byMilestone) {
        mid = (await detail(id, client)).milestones[0]!.id;
        await pool.query(
          `UPDATE contract_milestones SET status = 'funded', delivered_at = :last,
        dispute_opens_at = NULL, approval_due_at = NULL WHERE id = :mid`,
          { mid, last },
        );
        await pool.query(
          `INSERT INTO contract_status_history (contract_id, changed_by, new_status, note, created_at)
        VALUES (:id, :user, 'in_progress', 'Marco «Primeira parte» entregue: versão original', :first)`,
          { id, user: freelancer.id, first },
        );
      } else {
        await pool.query(
          `INSERT INTO deliveries (contract_id, message, delivered_at, created_at)
        VALUES (:id, 'Versão histórica original', :first, :first)`,
          { id, first },
        );
        await pool.query(
          `INSERT INTO deliveries (contract_id, message, delivered_at, created_at)
        VALUES (:id, 'Versão histórica posterior', :last, :last)`,
          { id, last },
        );
      }
      await delivered(id, freelancer, mid);
      expect((await row(id)).first_delivery_at).toEqual(first);
      const saved = mid ? await milestoneRow(mid) : await row(id);
      expect(mid ? saved.dispute_opens_at : saved.delivery_dispute_opens_at).toEqual(at(-72));
      expect((await detail(id, client)).disputeOpensAt).toBe(at(-72).toISOString());
      expect((await open(id, client)).status).toBe(201);
    },
  );

  it('a mediação automática por prazo vencido abre durante a espera da disputa manual', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    await pool.query(
      `UPDATE contracts SET accepted_at = :accepted, deadline_at = :deadline,
      overdue_notified_at = :notice, grace_ends_at = :now WHERE id = :id`,
      { id, accepted: at(-36), deadline: at(-35), notice: at(-24), now: NOW },
    );
    const early = await open(id, client);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'dispute_too_early', opensAt: at(12).toISOString() });
    const contract = await contractsRepository.findById(id);
    const auto = await contractsService.openOverdueDispute(contract!, NOW);
    expect(auto).toEqual(expect.any(Number));
    expect((await row(id)).status).toBe('disputed');
    expect(await disputeCount(id)).toBe(1);
    const [disputes] = await pool.query<RowDataPacket[]>(
      'SELECT reason FROM disputes WHERE contract_id = :id',
      { id },
    );
    expect(disputes[0]!.reason).toBe('deadline');
  });

  it.each([false, true])(
    'entrega × disputa sob a mesma trava produz apenas um estado consistente (marco=%s)',
    async (byMilestone) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer, byMilestone);
      await pool.query('UPDATE contracts SET accepted_at = :accepted WHERE id = :id', {
        id,
        accepted: at(-72),
      });
      const mid = byMilestone ? (await detail(id, client)).milestones[0]!.id : undefined;
      const money = await financial(id, client, freelancer);
      const settled = await race(
        id,
        () =>
          mid
            ? contractsService.deliverMilestone(id, mid, freelancer.id, 'Entrega concorrente')
            : contractsService.deliver(id, freelancer.id, { message: 'Entrega concorrente' }),
        () =>
          disputesService.open(client.id, {
            contractId: id,
            reason: 'quality',
            description: 'Disputa concorrente com a primeira entrega',
          }),
      );
      expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(
        (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.statusCode,
      ).toBe(409);
      const saved = await row(id);
      if (saved.status === 'disputed') {
        expect(await disputeCount(id)).toBe(1);
        expect(saved.first_delivery_at).toBeNull();
        if (mid) expect((await milestoneRow(mid)).status).toBe('funded');
        else {
          const [deliveries] = await pool.query<RowDataPacket[]>(
            'SELECT COUNT(*) AS n FROM deliveries WHERE contract_id = :id',
            { id },
          );
          expect(Number(deliveries[0]!.n)).toBe(0);
        }
      } else {
        expect(saved.status).toBe(byMilestone ? 'in_progress' : 'delivered');
        expect(saved.first_delivery_at).toEqual(NOW);
        expect(await disputeCount(id)).toBe(0);
        expect((await detail(id, client)).disputeOpensAt).toBe(at(48).toISOString());
      }
      expect(await financial(id, client, freelancer)).toEqual(money);
    },
  );
});
