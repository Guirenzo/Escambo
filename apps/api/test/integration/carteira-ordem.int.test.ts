import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request, { type Response } from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { withLegacyParallelContracts } from './helpers/legacy-parallel-contracts';

const app = createApp();
const NOW = new Date('2026-10-12T15:00:00Z');
type Mode = 'cash' | 'credits';
type Closing = 'cancel' | 'dispute';
interface Actor {
  id: number;
  token: string;
}
interface Arrival {
  connectionId: number;
  userId: number;
}
interface SqlError {
  connectionId: number;
  code?: string;
  errno?: number;
  sqlState?: string;
}
interface Evidence {
  mode: Mode;
  closing: Closing;
  contracts: number[];
  arrivalsBeforeRelease: Arrival[];
  locksBeforeRelease: RowDataPacket[];
  waitsBeforeRelease: RowDataPacket[];
  sqlErrors: SqlError[];
  deadlocksBefore?: number;
  deadlocksAfter?: number;
  responses?: { status: number; body: unknown }[];
}
type Query = (...args: unknown[]) => Promise<unknown>;
const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
let originalFee: string | null;

async function actor(role: 'client' | 'freelancer' | 'admin', mode: Mode): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
     VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo')`,
    { key, email: `wallet-order-${key}@escambo.test`, role },
  );
  await walletRepository.ensure(created.insertId);
  if (role === 'client') {
    await pool.query(
      'UPDATE wallets SET balance = :cash, credits_balance = :credits WHERE user_id = :id',
      {
        id: created.insertId,
        cash: mode === 'cash' ? 500 : 0,
        credits: mode === 'credits' ? 500 : 0,
      },
    );
  }
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function create(client: Actor, freelancer: Actor, mode: Mode): Promise<number> {
  const res = await request(app).post('/api/contracts').set(auth(client)).send({
    freelancerId: freelancer.id,
    title: 'Ordem global das carteiras',
    description: 'Contrato fictício da regressão MySQL/InnoDB',
    price: 100,
    paymentMode: mode,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function deadlocks(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT AS total FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'",
  );
  expect(rows, 'métrica real de deadlocks do MySQL/InnoDB disponível').toHaveLength(1);
  return Number(rows[0]!.total);
}

async function save(evidence: Evidence): Promise<void> {
  const directory = process.env.ADR61_LOCK_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${evidence.mode}-${evidence.closing}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

/**
 * Só controla o agendamento: cada query/BEGIN/COMMIT/ROLLBACK e seu resultado vêm do MySQL.
 * Pausa o retorno da PRIMEIRA UPDATE wallets real bem-sucedida de uma conexão. Na ordem
 * oposta, ambas detêm sua primeira linha e são soltas juntas (o InnoDB detecta o ciclo).
 * Na ordem global, a segunda aguarda a primeira carteira: vemos essa espera real e soltamos
 * a primeira operação SEM exigir que a segunda passe pela barreira. Assim o teste não
 * introduz um deadlock na implementação ordenada. Nenhum SQL ou dado financeiro é simulado.
 */
async function concurrent(
  evidence: Evidence,
  first: () => PromiseLike<Response>,
  second: () => PromiseLike<Response>,
): Promise<[Response, Response]> {
  const arrivals: Arrival[] = [];
  const connections = new Set<number>();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getConnection = pool.getConnection.bind(pool);
  const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
    const conn = await getConnection();
    connections.add(conn.threadId);
    const originalQuery = conn.query;
    const query = conn.query.bind(conn) as unknown as Query;
    const originalRelease = conn.release;
    let paused = false;
    const wrapped: Query = async (...args) => {
      let result: unknown;
      try {
        result = await query(...args);
      } catch (error) {
        const sqlError = error as { code?: string; errno?: number; sqlState?: string };
        evidence.sqlErrors.push({ connectionId: conn.threadId, ...sqlErrorFields(sqlError) });
        throw error;
      }
      if (!paused && typeof args[0] === 'string' && /^\s*UPDATE wallets\b/i.test(args[0])) {
        const [header] = result as [ResultSetHeader, unknown];
        if (header.affectedRows > 0) {
          paused = true;
          const parameters = args[1] as { userId: number };
          arrivals.push({ connectionId: conn.threadId, userId: parameters.userId });
          await barrier;
        }
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
  let firstWork: Promise<Response> | undefined;
  let work: Promise<[Response, Response]> | undefined;
  try {
    evidence.deadlocksBefore = await deadlocks();
    const a = (firstWork = Promise.resolve(first()));
    await waitUntil(async () => arrivals.length === 1, 'primeira operação não chegou à carteira');
    const b = Promise.resolve(second());
    work = Promise.all([a, b]);
    await waitUntil(async () => {
      const [waits] = await pool.query<RowDataPacket[]>(
        `SELECT rt.PROCESSLIST_ID AS requesting, bt.PROCESSLIST_ID AS blocking,
                requested.INDEX_NAME AS requested_index, requested.LOCK_DATA AS requested_key
           FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks requested
             ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
           JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID
           JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID
          WHERE requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = 'wallets'
            AND rt.PROCESSLIST_ID IN (:connections)`,
        { connections: [...connections] },
      );
      evidence.waitsBeforeRelease = waits;
      return (
        arrivals.length === 2 ||
        waits.some((row) => Number(row.blocking) === arrivals[0]!.connectionId)
      );
    }, 'segunda operação não adquiriu carteira nem aguardou a primeira no InnoDB');
    const [locks] = await pool.query<RowDataPacket[]>(
      `SELECT t.PROCESSLIST_ID AS connection_id, l.ENGINE_TRANSACTION_ID AS transaction_id,
              l.INDEX_NAME AS index_name, l.LOCK_TYPE AS lock_type, l.LOCK_MODE AS lock_mode,
              l.LOCK_STATUS AS lock_status, l.LOCK_DATA AS lock_data
         FROM performance_schema.data_locks l
         JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID
        WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'wallets'
          AND t.PROCESSLIST_ID IN (:connections)
        ORDER BY t.PROCESSLIST_ID, l.INDEX_NAME, l.LOCK_STATUS, l.LOCK_DATA`,
      { connections: [...connections] },
    );
    evidence.arrivalsBeforeRelease = [...arrivals];
    evidence.locksBeforeRelease = locks;
    expect(locks.filter((row) => row.lock_status === 'GRANTED').length).toBeGreaterThan(0);
  } finally {
    release();
    try {
      if (work) {
        const responses = await work;
        evidence.responses = responses.map((res) => ({ status: res.status, body: res.body }));
      } else if (firstWork) {
        await firstWork;
      }
    } finally {
      spy.mockRestore();
      evidence.deadlocksAfter = await deadlocks();
      await save(evidence);
    }
  }
  return work!;
}

function sqlErrorFields(error: Omit<SqlError, 'connectionId'>): Omit<SqlError, 'connectionId'> {
  return { code: error.code, errno: error.errno, sqlState: error.sqlState };
}

async function moneySnapshot(client: Actor, freelancer: Actor) {
  const ids = [client.id, freelancer.id];
  const [wallets] = await pool.query<RowDataPacket[]>(
    `SELECT user_id, balance, balance_pending, credits_balance, credits_pending
       FROM wallets WHERE user_id IN (:ids) ORDER BY user_id`,
    { ids },
  );
  const [cashLedger] = await pool.query<RowDataPacket[]>(
    `SELECT user_id, contract_id, amount, pending_delta, balance_after, pending_after, reason
       FROM wallet_transactions WHERE user_id IN (:ids) ORDER BY id`,
    { ids },
  );
  const [creditLedger] = await pool.query<RowDataPacket[]>(
    `SELECT user_id, contract_id, amount, balance_after, reason
       FROM credit_transactions WHERE user_id IN (:ids) ORDER BY id`,
    { ids },
  );
  return { wallets, cashLedger, creditLedger };
}

beforeAll(async () => {
  originalFee = await settingsRepository.get('platform_fee_percentage');
  await settingsRepository.set('platform_fee_percentage', '15', 'integer');
});
afterAll(async () => {
  setClockForTests(null);
  if (originalFee !== null)
    await settingsRepository.set('platform_fee_percentage', originalFee, 'integer');
  await pool.end();
});

describe('Ordem global das carteiras entre contratações distintas (I30)', () => {
  for (const mode of ['cash', 'credits'] as const) {
    for (const closing of ['cancel', 'dispute'] as const) {
      it(`${mode}: aceite × ${closing === 'cancel' ? 'cancelamento' : 'resolução de disputa'} concluem sem 1213 e com extratos exatos`, async () => {
        setClockForTests(NOW, { frozen: true });
        const client = await actor('client', mode);
        const freelancer = await actor('freelancer', mode);
        expect(client.id).toBeLessThan(freelancer.id);
        const closingContract = await create(client, freelancer, mode);
        await request(app)
          .post(`/api/contracts/${closingContract}/accept`)
          .set(auth(freelancer))
          .expect(200);

        let close: () => PromiseLike<Response>;
        let disputeId: number | undefined;
        if (closing === 'dispute') {
          setClockForTests(new Date(NOW.getTime() + 49 * 3_600_000), { frozen: true });
          const opened = await request(app)
            .post('/api/disputes')
            .set(auth(client))
            .send({
              contractId: closingContract,
              reason: 'not_delivered',
              description: 'Disputa fictícia aberta depois da espera de quarenta e oito horas',
            })
            .expect(201);
          disputeId = opened.body.id as number;
          const admin = await actor('admin', mode);
          close = () =>
            request(app)
              .post(`/api/admin/disputes/${disputeId}/resolve`)
              .set(auth(admin))
              .send({ resolution: 'refund_client', note: 'Decisão fictícia da regressão' });
        } else {
          close = () =>
            request(app)
              .post(`/api/contracts/${closingContract}/cancel`)
              .set(auth(client))
              .send({ expectedRefund: mode === 'cash' ? 50 : 100 });
        }
        // Monta a duplicidade histórica pré-RN-020 antes da corrida. A proposta tem validade
        // posterior à abertura da disputa, e ambos os contratos mantêm suas reservas reais.
        const acceptingContract = await withLegacyParallelContracts(client.id, freelancer.id, () =>
          create(client, freelancer, mode),
        );
        const accept = () =>
          request(app).post(`/api/contracts/${acceptingContract}/accept`).set(auth(freelancer));
        const evidence: Evidence = {
          mode,
          closing,
          contracts: [acceptingContract, closingContract],
          arrivalsBeforeRelease: [],
          locksBeforeRelease: [],
          waitsBeforeRelease: [],
          sqlErrors: [],
        };
        const results = await concurrent(evidence, accept, close);
        expect
          .soft(
            results.map((res) => res.status),
            JSON.stringify(evidence),
          )
          .toEqual([200, 200]);
        expect.soft(evidence.sqlErrors).toEqual([]);
        expect.soft(evidence.deadlocksAfter).toBe(evidence.deadlocksBefore);
        const [contracts] = await pool.query<RowDataPacket[]>(
          'SELECT id, status FROM contracts WHERE id IN (:ids) ORDER BY id',
          { ids: [acceptingContract, closingContract] },
        );
        expect.soft(contracts).toEqual([
          { id: closingContract, status: 'cancelled' },
          { id: acceptingContract, status: 'accepted' },
        ]);
        if (disputeId) {
          const [disputes] = await pool.query<RowDataPacket[]>(
            'SELECT status, resolution FROM disputes WHERE id = :id',
            { id: disputeId },
          );
          expect.soft(disputes).toEqual([{ status: 'resolved', resolution: 'refund_client' }]);
        }
        const snapshot = await moneySnapshot(client, freelancer);
        expect.soft(snapshot.wallets).toEqual([
          {
            user_id: client.id,
            balance: mode === 'cash' ? (closing === 'cancel' ? '350.00' : '400.00') : '0.00',
            balance_pending: '0.00',
            credits_balance: mode === 'credits' ? 400 : 0,
            credits_pending: 0,
          },
          {
            user_id: freelancer.id,
            balance: mode === 'cash' && closing === 'cancel' ? '42.50' : '0.00',
            balance_pending: mode === 'cash' ? '85.00' : '0.00',
            credits_balance: 0,
            credits_pending: mode === 'credits' ? 100 : 0,
          },
        ]);
        if (mode === 'cash') {
          expect.soft(snapshot.creditLedger).toEqual([]);
          const effects = (id: number) =>
            snapshot.cashLedger
              .filter((row) => row.contract_id === id)
              .map((row) => ({
                user: row.user_id,
                amount: Number(row.amount),
                pending: Number(row.pending_delta),
                reason: row.reason,
              }));
          const accepted = [
            { user: client.id, amount: -100, pending: 100, reason: 'hold' },
            { user: client.id, amount: 0, pending: -100, reason: 'payment' },
            { user: freelancer.id, amount: 0, pending: 85, reason: 'escrow_in' },
          ];
          expect.soft(effects(acceptingContract)).toEqual(accepted);
          expect.soft(effects(closingContract)).toEqual([
            ...accepted,
            {
              user: freelancer.id,
              amount: closing === 'cancel' ? 42.5 : 0,
              pending: -85,
              reason: closing === 'cancel' ? 'escrow_release' : 'escrow_refund',
            },
            {
              user: client.id,
              amount: closing === 'cancel' ? 50 : 100,
              pending: 0,
              reason: 'refund',
            },
          ]);
          for (const user of [client, freelancer]) {
            let balance = user.id === client.id ? 500 : 0;
            let pending = 0;
            for (const row of snapshot.cashLedger.filter((entry) => entry.user_id === user.id)) {
              balance += Number(row.amount);
              pending += Number(row.pending_delta);
              expect.soft(Number(row.balance_after)).toBe(balance);
              expect.soft(Number(row.pending_after)).toBe(pending);
            }
          }
        } else {
          expect.soft(snapshot.cashLedger).toEqual([]);
          const effects = (id: number) =>
            snapshot.creditLedger
              .filter((row) => row.contract_id === id)
              .map((row) => ({
                user: row.user_id,
                amount: Number(row.amount),
                reason: row.reason,
              }));
          const accepted = [
            { user: client.id, amount: -100, reason: 'escrow_hold' },
            { user: freelancer.id, amount: 100, reason: 'escrow_in' },
          ];
          expect.soft(effects(acceptingContract)).toEqual(accepted);
          expect
            .soft(effects(closingContract))
            .toEqual([
              ...accepted,
              { user: freelancer.id, amount: -100, reason: 'escrow_refund' },
              { user: client.id, amount: 100, reason: 'refund' },
            ]);
          for (const user of [client, freelancer]) {
            let total = user.id === client.id ? 500 : 0;
            for (const row of snapshot.creditLedger.filter((entry) => entry.user_id === user.id)) {
              total += Number(row.amount);
              expect.soft(Number(row.balance_after)).toBe(total);
            }
          }
        }
        // Repetir as ações já encerradas não duplica saldos, extratos ou a decisão.
        await accept().then((res) => expect.soft(res.status).toBe(409));
        await close().then((res) => expect.soft(res.status).toBe(409));
        expect.soft(await moneySnapshot(client, freelancer)).toEqual(snapshot);
        const [mismatches] = await pool.query<RowDataPacket[]>(
          `SELECT c.id FROM contracts c LEFT JOIN wallet_transactions t
             ON t.contract_id = c.id AND t.user_id = c.client_id
            WHERE c.payment_mode = 'cash' AND c.barter_agreement_id IS NULL
            GROUP BY c.id, c.status, c.price
           HAVING COALESCE(SUM(t.pending_delta), 0) <> IF(c.status = 'pending', c.price, 0)`,
        );
        expect.soft(mismatches).toEqual([]);
      });
    }
  }
});
