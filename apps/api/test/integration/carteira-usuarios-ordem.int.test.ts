import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request, { type Response } from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { withLegacyParallelContracts } from './helpers/legacy-parallel-contracts';
import { deleteUsersWithoutLedger } from './helpers/ledger-cleanup';

const app = createApp();
const NOW = new Date('2026-10-12T15:00:00Z');
type Mode = 'cash' | 'credits';
type Scenario = 'milestone-dropout' | 'reciprocal-dropouts' | 'agreement-dropout';
type Query = (...args: unknown[]) => Promise<unknown>;
interface Actor {
  id: number;
  token: string;
}
interface Evidence {
  mode: Mode;
  scenario: Scenario;
  contracts: number[];
  arrivals: { connectionId: number; table: string; userId: number }[];
  locks: RowDataPacket[];
  waits: RowDataPacket[];
  sqlErrors: { connectionId: number; code?: string; errno?: number; sqlState?: string }[];
  responses?: { status: number; body: unknown }[];
  deadlocksBefore?: number;
  deadlocksAfter?: number;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
const ownedUsers: number[] = [];
const ownedContracts: number[] = [];

async function actor(role: 'client' | 'freelancer', funded = true): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid,email,role,status,timezone)
     VALUES (:key,:email,:role,'active','America/Sao_Paulo')`,
    { key, email: `wallet-users-${key}@escambo.test`, role },
  );
  ownedUsers.push(created.insertId);
  await walletRepository.ensure(created.insertId);
  await pool.query('UPDATE wallets SET balance=:funds,credits_balance=:funds WHERE user_id=:id', {
    id: created.insertId,
    funds: funded ? 500 : 0,
  });
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function accepted(client: Actor, freelancer: Actor, mode: Mode, milestones = false) {
  const created = await request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title: 'Ordem de usuários e carteiras',
      description: 'Regressão real das travas e chaves estrangeiras dos extratos',
      price: 100,
      paymentMode: mode,
      ...(milestones
        ? {
            milestones: [
              { title: 'Primeiro marco', amount: 50 },
              { title: 'Segundo marco', amount: 50 },
            ],
          }
        : {}),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  ownedContracts.push(id);
  const result = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer));
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const detail = await request(app).get(`/api/contracts/${id}`).set(auth(client));
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body as {
    id: number;
    freelancerNet: number;
    milestones: { id: number; freelancerNet: number }[];
  };
}

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function deadlocks() {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT AS n FROM information_schema.INNODB_METRICS WHERE NAME='lock_deadlocks'",
  );
  return Number(rows[0]?.n ?? 0);
}

async function save(evidence: Evidence) {
  const directory = process.env.ADR61_USER_LOCK_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${evidence.mode}-${evidence.scenario}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

/**
 * Agendamento de queries reais, sem simular SQL, erro ou resultado. No primeiro cenário,
 * pausa o marco depois de adquirir a carteira; deixa a desistência chegar à trava users X
 * e à espera da carteira antes de liberar o extrato (cuja FK precisa de users S).
 * Na implementação ordenada, a desistência espera users ANTES de adquirir outra carteira;
 * essa espera real também libera a barreira, sem forçar a segunda ação a atravessá-la.
 * Para desistências recíprocas, pausa após users X de cada transação: duas chegadas expõem
 * o ciclo antigo, enquanto uma chegada + espera users permite a serialização corrigida.
 */
async function concurrent(
  evidence: Evidence,
  first: () => PromiseLike<Response>,
  second: () => PromiseLike<Response>,
): Promise<[Response, Response]> {
  let release!: () => void;
  let released = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connections = new Set<number>();
  const getConnection = pool.getConnection.bind(pool);
  const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
    const conn = await getConnection();
    connections.add(conn.threadId);
    const originalQuery = conn.query;
    const originalRelease = conn.release;
    const query = conn.query.bind(conn) as unknown as Query;
    let paused = false;
    const wrapped: Query = async (...args) => {
      let result: unknown;
      try {
        result = await query(...args);
      } catch (error) {
        const sqlError = error as { code?: string; errno?: number; sqlState?: string };
        evidence.sqlErrors.push({
          connectionId: conn.threadId,
          code: sqlError.code,
          errno: sqlError.errno,
          sqlState: sqlError.sqlState,
        });
        throw error;
      }
      const sql = typeof args[0] === 'string' ? args[0] : '';
      const parameters = args[1] as Record<string, unknown> | undefined;
      const table = /\bFROM users\b[\s\S]*\bFOR UPDATE\b/i.test(sql)
        ? 'users'
        : /^\s*UPDATE wallets\b/i.test(sql)
          ? 'wallets'
          : '';
      const shouldPause =
        evidence.scenario !== 'milestone-dropout'
          ? table === 'users'
          : table === 'wallets' && evidence.arrivals.length === 0;
      if (!released && !paused && shouldPause) {
        paused = true;
        evidence.arrivals.push({
          connectionId: conn.threadId,
          table,
          userId: Number(parameters?.userId ?? parameters?.uid ?? parameters?.id),
        });
        await barrier;
      }
      return result;
    };
    conn.query = wrapped as PoolConnection['query'];
    conn.release = () => {
      conn.query = originalQuery;
      conn.release = originalRelease;
      originalRelease.call(conn);
    };
    return conn;
  });
  const work: Promise<Response>[] = [];
  evidence.deadlocksBefore = await deadlocks();
  try {
    work.push(Promise.resolve(first()));
    await until(
      async () => evidence.arrivals.length === 1,
      'primeira ação não chegou à trava real',
    );
    work.push(Promise.resolve(second()));
    await until(async () => {
      const [waits] = await pool.query<RowDataPacket[]>(
        `SELECT rt.PROCESSLIST_ID AS requesting,bt.PROCESSLIST_ID AS blocking,
          requested.OBJECT_NAME AS table_name,requested.INDEX_NAME AS index_name,
          requested.LOCK_MODE AS lock_mode,requested.LOCK_DATA AS lock_data
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
         JOIN performance_schema.threads rt ON rt.THREAD_ID=w.REQUESTING_THREAD_ID
         JOIN performance_schema.threads bt ON bt.THREAD_ID=w.BLOCKING_THREAD_ID
         WHERE requested.OBJECT_SCHEMA=DATABASE() AND requested.OBJECT_NAME IN ('users','wallets')
         AND rt.PROCESSLIST_ID IN (:connections)`,
        { connections: [...connections] },
      );
      evidence.waits = waits;
      return (
        evidence.arrivals.length === 2 ||
        waits.some((row) => Number(row.blocking) === evidence.arrivals[0]!.connectionId)
      );
    }, 'segunda ação não aguardou users/carteira nem chegou à segunda trava');
    const [locks] = await pool.query<RowDataPacket[]>(
      `SELECT t.PROCESSLIST_ID AS connection_id,l.OBJECT_NAME AS table_name,
        l.INDEX_NAME AS index_name,l.LOCK_MODE AS lock_mode,l.LOCK_STATUS AS lock_status,l.LOCK_DATA AS lock_data
       FROM performance_schema.data_locks l
       JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID
       WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME IN ('users','wallets')
       AND t.PROCESSLIST_ID IN (:connections)
       ORDER BY t.PROCESSLIST_ID,l.OBJECT_NAME,l.INDEX_NAME,l.LOCK_DATA`,
      { connections: [...connections] },
    );
    evidence.locks = locks;
    expect(locks.some((row) => row.lock_status === 'GRANTED')).toBe(true);
  } finally {
    released = true;
    release();
    const results = await Promise.allSettled(work);
    evidence.responses = results.map((result) =>
      result.status === 'fulfilled'
        ? { status: result.value.status, body: result.value.body }
        : { status: 0, body: String(result.reason) },
    );
    spy.mockRestore();
    evidence.deadlocksAfter = await deadlocks();
    await save(evidence);
  }
  return (await Promise.all(work)) as [Response, Response];
}

async function snapshot(users: Actor[], contracts: number[]) {
  const [wallets] = await pool.query<RowDataPacket[]>(
    'SELECT user_id,balance,balance_pending,credits_balance,credits_pending FROM wallets WHERE user_id IN (:ids) ORDER BY user_id',
    { ids: users.map((a) => a.id) },
  );
  const [cashLedger] = await pool.query<RowDataPacket[]>(
    'SELECT user_id,contract_id,amount,pending_delta,balance_after,pending_after,reason FROM wallet_transactions WHERE contract_id IN (:ids) ORDER BY id',
    { ids: contracts },
  );
  const [creditLedger] = await pool.query<RowDataPacket[]>(
    'SELECT user_id,contract_id,amount,balance_after,reason FROM credit_transactions WHERE contract_id IN (:ids) ORDER BY id',
    { ids: contracts },
  );
  const [history] = await pool.query<RowDataPacket[]>(
    'SELECT contract_id,new_status,note FROM contract_status_history WHERE contract_id IN (:ids) ORDER BY id',
    { ids: contracts },
  );
  const [dropouts] = await pool.query<RowDataPacket[]>(
    'SELECT contract_id,freelancer_id,dropped_at,client_agreed_at FROM freelancer_dropouts WHERE contract_id IN (:ids) ORDER BY id',
    { ids: contracts },
  );
  return { wallets, cashLedger, creditLedger, history, dropouts };
}

/** Saldos finais também são reconstruídos pelos lançamentos, além dos valores da API. */
function expectLedgerReconciles(
  state: Awaited<ReturnType<typeof snapshot>>,
  initial: { actor: Actor; funds: number }[],
) {
  for (const { actor, funds } of initial) {
    const wallet = state.wallets.find((row) => row.user_id === actor.id)!;
    const cash = state.cashLedger.filter((row) => row.user_id === actor.id);
    const credits = state.creditLedger.filter((row) => row.user_id === actor.id);
    const sum = (rows: RowDataPacket[], column: string) =>
      rows.reduce((total, row) => total + Number(row[column]), 0);
    expect(Number(wallet.balance)).toBeCloseTo(funds + sum(cash, 'amount'), 2);
    expect(Number(wallet.balance_pending)).toBeCloseTo(sum(cash, 'pending_delta'), 2);
    expect(Number(wallet.credits_balance) + Number(wallet.credits_pending)).toBe(
      funds + sum(credits, 'amount'),
    );
  }
}

beforeAll(() => setClockForTests(NOW, { frozen: true }));
afterEach(async () => {
  vi.restoreAllMocks();
  if (ownedUsers.length) {
    await pool.query('DELETE FROM notifications WHERE user_id IN (:ids)', { ids: ownedUsers });
    await pool.query(
      "DELETE FROM content_reports WHERE target_type='user' AND target_id IN (:ids)",
      { ids: ownedUsers },
    );
  }
  if (ownedContracts.length)
    await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: ownedContracts });
  // Extrato imutável (RNF-036): quem tem lançamento fica, com os lançamentos.
  await deleteUsersWithoutLedger(ownedUsers);
  ownedUsers.length = ownedContracts.length = 0;
});
afterAll(async () => {
  setClockForTests(null);
  await pool.end();
});

describe('Ordem users → wallets também cobre as FKs dos extratos (I30)', () => {
  it.each(['cash', 'credits'] as const)(
    '%s: aprovar marco e desistir de outro contrato concluem sem 1213',
    async (mode) => {
      const client = await actor('client');
      const freelancer = await actor('freelancer', false);
      const milestoneContract = await accepted(client, freelancer, mode, true);
      // Duas contratações históricas da mesma dupla, montadas antes de iniciar a corrida.
      const dropoutContract = await withLegacyParallelContracts(client.id, freelancer.id, () =>
        accepted(client, freelancer, mode),
      );
      const milestone = milestoneContract.milestones[0]!;
      await request(app)
        .post(`/api/contracts/${milestoneContract.id}/milestones/${milestone.id}/deliver`)
        .set(auth(freelancer))
        .send({ message: 'Primeiro marco entregue para aprovação.' })
        .expect(200);
      const evidence: Evidence = {
        mode,
        scenario: 'milestone-dropout',
        contracts: [milestoneContract.id, dropoutContract.id],
        arrivals: [],
        locks: [],
        waits: [],
        sqlErrors: [],
      };
      const responses = await concurrent(
        evidence,
        () =>
          request(app)
            .post(`/api/contracts/${milestoneContract.id}/milestones/${milestone.id}/approve`)
            .set(auth(client)),
        () =>
          request(app)
            .post(`/api/contracts/${dropoutContract.id}/cancel`)
            .set(auth(freelancer))
            .send({ expectedDropoutCount: 1 }),
      );
      expect(
        evidence.sqlErrors.filter((error) => error.errno === 1213),
        JSON.stringify(evidence.responses),
      ).toEqual([]);
      expect(
        responses.map((r) => r.status),
        JSON.stringify(evidence.responses),
      ).toEqual([200, 200]);
      const beforeRetry = await snapshot([client, freelancer], evidence.contracts);
      expectLedgerReconciles(beforeRetry, [
        { actor: client, funds: 500 },
        { actor: freelancer, funds: 0 },
      ]);
      const balanceKey = mode === 'cash' ? 'balance' : 'credits_balance';
      const pendingKey = mode === 'cash' ? 'balance_pending' : 'credits_pending';
      expect(Number(beforeRetry.wallets[0]![balanceKey])).toBe(400);
      expect(Number(beforeRetry.wallets[0]![pendingKey])).toBe(0);
      expect(Number(beforeRetry.wallets[1]![balanceKey])).toBe(milestone.freelancerNet);
      expect(Number(beforeRetry.wallets[1]![pendingKey])).toBe(
        milestoneContract.freelancerNet - milestone.freelancerNet,
      );
      expect(beforeRetry.dropouts).toHaveLength(1);
      expect(beforeRetry.history.filter((h) => h.new_status === 'cancelled')).toHaveLength(1);
      const ledger = mode === 'cash' ? beforeRetry.cashLedger : beforeRetry.creditLedger;
      expect(ledger.filter((t) => t.reason === 'escrow_release')).toHaveLength(1);
      expect(ledger.filter((t) => t.reason === 'escrow_refund')).toHaveLength(1);
      expect(ledger.filter((t) => t.reason === 'refund')).toHaveLength(1);
      await request(app)
        .post(`/api/contracts/${milestoneContract.id}/milestones/${milestone.id}/approve`)
        .set(auth(client))
        .expect(409);
      await request(app)
        .post(`/api/contracts/${dropoutContract.id}/cancel`)
        .set(auth(freelancer))
        .expect(409);
      expect(await snapshot([client, freelancer], evidence.contracts)).toEqual(beforeRetry);
    },
  );

  it.each(['cash', 'credits'] as const)(
    '%s: desistências recíprocas preservam ordem global inclusive users S/X',
    async (mode) => {
      const low = await actor('freelancer');
      const high = await actor('freelancer');
      const first = await accepted(low, high, mode);
      const second = await accepted(high, low, mode);
      const evidence: Evidence = {
        mode,
        scenario: 'reciprocal-dropouts',
        contracts: [first.id, second.id],
        arrivals: [],
        locks: [],
        waits: [],
        sqlErrors: [],
      };
      const responses = await concurrent(
        evidence,
        () =>
          request(app)
            .post(`/api/contracts/${first.id}/cancel`)
            .set(auth(high))
            .send({ expectedDropoutCount: 1 }),
        () =>
          request(app)
            .post(`/api/contracts/${second.id}/cancel`)
            .set(auth(low))
            .send({ expectedDropoutCount: 1 }),
      );
      expect(
        evidence.sqlErrors.filter((error) => error.errno === 1213),
        JSON.stringify(evidence.responses),
      ).toEqual([]);
      expect(
        responses.map((r) => r.status),
        JSON.stringify(evidence.responses),
      ).toEqual([200, 200]);
      const beforeRetry = await snapshot([low, high], evidence.contracts);
      expectLedgerReconciles(beforeRetry, [
        { actor: low, funds: 500 },
        { actor: high, funds: 500 },
      ]);
      const balanceKey = mode === 'cash' ? 'balance' : 'credits_balance';
      const pendingKey = mode === 'cash' ? 'balance_pending' : 'credits_pending';
      expect(beforeRetry.wallets.map((w) => Number(w[balanceKey]))).toEqual([500, 500]);
      expect(beforeRetry.wallets.map((w) => Number(w[pendingKey]))).toEqual([0, 0]);
      expect(beforeRetry.dropouts).toHaveLength(2);
      expect(beforeRetry.history.filter((h) => h.new_status === 'cancelled')).toHaveLength(2);
      const ledger = mode === 'cash' ? beforeRetry.cashLedger : beforeRetry.creditLedger;
      expect(ledger.filter((t) => t.reason === 'escrow_refund')).toHaveLength(2);
      expect(ledger.filter((t) => t.reason === 'refund')).toHaveLength(2);
      await request(app).post(`/api/contracts/${first.id}/cancel`).set(auth(high)).expect(409);
      await request(app).post(`/api/contracts/${second.id}/cancel`).set(auth(low)).expect(409);
      expect(await snapshot([low, high], evidence.contracts)).toEqual(beforeRetry);
    },
  );

  it.each(['cash', 'credits'] as const)(
    '%s: confirmar desistência combinada e desistir de contrato recíproco não invertem users',
    async (mode) => {
      const low = await actor('freelancer');
      const high = await actor('freelancer');
      const first = await accepted(low, high, mode);
      const second = await accepted(high, low, mode);
      await request(app)
        .post(`/api/contracts/${first.id}/cancel`)
        .set(auth(high))
        .send({ expectedDropoutCount: 1 })
        .expect(200);
      const evidence: Evidence = {
        mode,
        scenario: 'agreement-dropout',
        contracts: [first.id, second.id],
        arrivals: [],
        locks: [],
        waits: [],
        sqlErrors: [],
      };
      const responses = await concurrent(
        evidence,
        () => request(app).post(`/api/contracts/${first.id}/dropout/agreed`).set(auth(low)),
        () =>
          request(app)
            .post(`/api/contracts/${second.id}/cancel`)
            .set(auth(low))
            .send({ expectedDropoutCount: 1 }),
      );
      expect(
        evidence.sqlErrors.filter((error) => error.errno === 1213),
        JSON.stringify(evidence.responses),
      ).toEqual([]);
      expect(
        responses.map((r) => r.status),
        JSON.stringify(evidence.responses),
      ).toEqual([200, 200]);
      const beforeRetry = await snapshot([low, high], evidence.contracts);
      expectLedgerReconciles(beforeRetry, [
        { actor: low, funds: 500 },
        { actor: high, funds: 500 },
      ]);
      const balanceKey = mode === 'cash' ? 'balance' : 'credits_balance';
      const pendingKey = mode === 'cash' ? 'balance_pending' : 'credits_pending';
      expect(beforeRetry.wallets.map((w) => Number(w[balanceKey]))).toEqual([500, 500]);
      expect(beforeRetry.wallets.map((w) => Number(w[pendingKey]))).toEqual([0, 0]);
      expect(beforeRetry.dropouts).toHaveLength(2);
      expect(
        beforeRetry.dropouts.find((d) => d.contract_id === first.id)!.client_agreed_at,
      ).toEqual(NOW);
      expect(
        beforeRetry.history.filter((h) => String(h.note).includes('desistência foi combinada')),
      ).toHaveLength(1);
      const ledger = mode === 'cash' ? beforeRetry.cashLedger : beforeRetry.creditLedger;
      expect(ledger.filter((t) => t.reason === 'escrow_refund')).toHaveLength(2);
      expect(ledger.filter((t) => t.reason === 'refund')).toHaveLength(2);
      await request(app)
        .post(`/api/contracts/${first.id}/dropout/agreed`)
        .set(auth(low))
        .expect(409);
      await request(app).post(`/api/contracts/${second.id}/cancel`).set(auth(low)).expect(409);
      expect(await snapshot([low, high], evidence.contracts)).toEqual(beforeRetry);
    },
  );
});
