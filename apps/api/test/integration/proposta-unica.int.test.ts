import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request, { type Response } from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { withLegacyParallelContracts } from './helpers/legacy-parallel-contracts';

const app = createApp();
const NOW = new Date('2026-10-16T15:00:00Z');
const users: number[] = [];
type Mode = 'cash' | 'credits';
interface Actor {
  id: number;
  token: string;
}
const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function actor(): Promise<Actor> {
  const key = ulid();
  const [row] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid,email,role,status,timezone,email_frequency)
     VALUES (:key,:email,'freelancer','active','America/Sao_Paulo','off')`,
    { key, email: `unique-${key}@escambo.test` },
  );
  users.push(row.insertId);
  await walletRepository.ensure(row.insertId);
  await pool.query('UPDATE wallets SET balance=1000,credits_balance=1000 WHERE user_id=:id', {
    id: row.insertId,
  });
  return {
    id: row.insertId,
    token: jwt.sign({ sub: key, uid: row.insertId, role: 'freelancer' }, env.JWT_SECRET, {
      expiresIn: '1h',
    }),
  };
}

function propose(
  client: Actor,
  freelancer: Actor,
  mode: Mode = 'cash',
  extra: Record<string, unknown> = {},
) {
  return request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title: 'Proposta exclusiva',
      description: 'Serviço fictício para conferir a proposta única.',
      price: 100,
      paymentMode: mode,
      ...extra,
    });
}

async function snapshot(client: Actor) {
  const [wallet] = await pool.query<RowDataPacket[]>('SELECT * FROM wallets WHERE user_id=:id', {
    id: client.id,
  });
  const [ledger] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM wallet_transactions WHERE user_id=:id ORDER BY id',
    { id: client.id },
  );
  const [contracts] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM contracts WHERE client_id=:id ORDER BY id',
    { id: client.id },
  );
  const [offers] = await pool.query<RowDataPacket[]>(
    'SELECT o.* FROM contract_offers o JOIN contracts c ON c.id=o.contract_id WHERE c.client_id=:id ORDER BY o.id',
    { id: client.id },
  );
  const [history] = await pool.query<RowDataPacket[]>(
    'SELECT h.* FROM contract_status_history h JOIN contracts c ON c.id=h.contract_id WHERE c.client_id=:id ORDER BY h.id',
    { id: client.id },
  );
  return { wallet, ledger, contracts, offers, history };
}

async function legacy(
  client: Actor,
  freelancer: Actor,
  status: string,
  mode = 'cash',
  agreementId: number | null = null,
) {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid,client_id,freelancer_id,title,description,price,platform_fee,freelancer_net,status,payment_mode,barter_agreement_id)
     VALUES (:key,:client,:freelancer,'Legado preservado','Fixture anterior à RN-020',100,0,100,:status,:mode,:agreementId)`,
    { key: ulid(), client: client.id, freelancer: freelancer.id, status, mode, agreementId },
  );
  return result.insertId;
}

/** Observe espera real no InnoDB antes de liberar todas as requisições. */
async function simultaneous(client: Actor, calls: (() => PromiseLike<Response>)[]) {
  const blocker = await pool.getConnection();
  let responses: Promise<Response[]> | undefined;
  let waits: RowDataPacket[] = [];
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM users WHERE id=:id FOR UPDATE', { id: client.id });
    responses = Promise.all(calls.map((call) => Promise.resolve(call())));
    const until = Date.now() + 8000;
    do {
      [waits] = await pool.query<RowDataPacket[]>(
        `SELECT w.REQUESTING_ENGINE_TRANSACTION_ID, w.BLOCKING_ENGINE_TRANSACTION_ID,l.LOCK_DATA,l.LOCK_MODE
         FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l
           ON l.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID
         WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='users' AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA=:id`,
        { id: String(client.id) },
      );
      if (waits.length >= calls.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < until);
    expect(waits.length, 'as requisições chegaram à trava real da conta').toBeGreaterThanOrEqual(
      calls.length,
    );
  } finally {
    await blocker.rollback();
    blocker.release();
    if (responses) await responses.catch(() => undefined);
  }
  return { responses: await responses!, waits };
}

beforeEach(() => setClockForTests(NOW, { frozen: true }));
afterEach(() => setClockForTests(null));
afterAll(async () => {
  try {
    if (users.length) {
      await pool.query('DELETE FROM wallet_transactions WHERE user_id IN (:ids)', { ids: users });
      await pool.query('DELETE FROM contracts WHERE client_id IN (:ids)', { ids: users });
      await pool.query('DELETE FROM barter_agreements WHERE proposer_id IN (:ids)', { ids: users });
      await pool.query('DELETE FROM users WHERE id IN (:ids)', { ids: users });
    }
  } finally {
    setClockForTests(null);
    await pool.end();
  }
});

describe('RN-020 — uma contratação direta aberta por par ordenado', () => {
  it.each(['pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed'])(
    '%s bloqueia nova proposta e não altera o legado nem o financeiro',
    async (status) => {
      const client = await actor();
      const freelancer = await actor();
      const id = await legacy(client, freelancer, status);
      const before = await snapshot(client);
      const response = await propose(client, freelancer, 'credits', { title: 'Título diferente' });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body).toMatchObject({ error: 'active_contract_exists', contractId: id });
      expect(await snapshot(client)).toEqual(before);
    },
  );

  it.each(['completed', 'rejected', 'cancelled'])(
    '%s permite uma nova proposta',
    async (status) => {
      const client = await actor();
      const freelancer = await actor();
      const old = await legacy(client, freelancer, status);
      const response = await propose(client, freelancer);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.id).not.toBe(old);
      const state = await snapshot(client);
      expect(state.contracts.find((c) => c.id === old)?.status).toBe(status);
      expect(state.wallet[0]).toMatchObject({ balance: '900.00', balance_pending: '100.00' });
    },
  );

  it('recusa ou retirada real libera o par e devolve a reserva', async () => {
    const client = await actor();
    const freelancer = await actor();
    for (const action of ['reject', 'cancel']) {
      const first = await propose(client, freelancer).expect(201);
      await request(app)
        .post(`/api/contracts/${first.body.id}/${action}`)
        .set(auth(action === 'reject' ? freelancer : client))
        .send({})
        .expect(200);
      const state = await snapshot(client);
      expect(state.wallet[0]).toMatchObject({ balance: '1000.00', balance_pending: '0.00' });
    }
    await propose(client, freelancer).expect(201);
  });

  it('a forma de pagamento, o serviço e o título não contornam o bloqueio', async () => {
    const client = await actor();
    const freelancer = await actor();
    const first = await propose(client, freelancer, 'credits').expect(201);
    const [service] = await pool.query<ResultSetHeader>(
      `INSERT INTO services (user_id,category_id,title,description,price_type,price,is_active)
       SELECT :owner,id,'Outro serviço','Outra descrição fictícia','fixed',100,1 FROM service_categories ORDER BY id LIMIT 1`,
      { owner: freelancer.id },
    );
    const before = await snapshot(client);
    const second = await propose(client, freelancer, 'cash', {
      serviceId: service.insertId,
      title: 'Outro título',
    }).expect(409);
    expect(second.body.contractId).toBe(first.body.id);
    expect(await snapshot(client)).toEqual(before);
  });

  it('pares distintos e a direção inversa continuam independentes, sem revelar contrato alheio', async () => {
    const a = await actor();
    const b = await actor();
    const c = await actor();
    const ab = await propose(a, b, 'credits').expect(201);
    await propose(b, a, 'credits').expect(201);
    await propose(a, c, 'credits').expect(201);
    const cb = await propose(c, b, 'credits').expect(201);
    const duplicate = await propose(c, b).expect(409);
    expect(duplicate.body.contractId).toBe(cb.body.id);
    expect(duplicate.body.contractId).not.toBe(ab.body.id);
    await request(app).get(`/api/contracts/${ab.body.id}`).set(auth(c)).expect(403);
  });

  it('múltiplos legados são preservados e só liberam o par quando todos encerram', async () => {
    const client = await actor();
    const freelancer = await actor();
    const first = await legacy(client, freelancer, 'accepted');
    const second = await legacy(client, freelancer, 'disputed', 'credits');
    expect((await propose(client, freelancer).expect(409)).body.contractId).toBe(first);
    await pool.query("UPDATE contracts SET status='completed' WHERE id=:id", { id: first });
    expect((await propose(client, freelancer).expect(409)).body.contractId).toBe(second);
    await pool.query("UPDATE contracts SET status='completed' WHERE id=:id", { id: second });
    await propose(client, freelancer).expect(201);
  });

  it('trocas pendentes e seus contratos gerados permanecem independentes da contratação direta', async () => {
    const client = await actor();
    const freelancer = await actor();
    const [agreement] = await pool.query<ResultSetHeader>(
      `INSERT INTO barter_agreements (ulid,proposer_id,receiver_id,estimated_value_offered,estimated_value_requested,cash_difference,platform_fee,torna_status,status)
       VALUES (:key,:client,:freelancer,100,100,0,0,'none','proposed')`,
      { key: ulid(), client: client.id, freelancer: freelancer.id },
    );
    await legacy(client, freelancer, 'accepted', 'barter', agreement.insertId);
    const response = await propose(client, freelancer, 'credits').expect(201);
    expect((await propose(client, freelancer).expect(409)).body.contractId).toBe(response.body.id);
  });

  it.each(['cash', 'credits'] as const)(
    '%s simultâneo cria só uma proposta, oferta e reserva',
    async (mode) => {
      const client = await actor();
      const freelancer = await actor();
      const { responses, waits } = await simultaneous(
        client,
        Array.from({ length: 4 }, () => () => propose(client, freelancer, mode)),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      const created = responses.find((r) => r.status === 201)!;
      for (const rejected of responses.filter((r) => r.status === 409))
        expect(rejected.body).toMatchObject({
          error: 'active_contract_exists',
          contractId: created.body.id,
        });
      const state = await snapshot(client);
      expect(state.contracts).toHaveLength(1);
      expect(state.offers).toHaveLength(1);
      expect(state.history).toHaveLength(1);
      expect(state.ledger).toHaveLength(mode === 'cash' ? 1 : 0);
      expect(state.wallet[0]).toMatchObject({
        balance: mode === 'cash' ? '900.00' : '1000.00',
        balance_pending: mode === 'cash' ? '100.00' : '0.00',
        credits_balance: 1000,
        credits_pending: 0,
      });
      const directory = process.env.RN020_EVIDENCE_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `concurrent-${mode}.json`),
          JSON.stringify(
            {
              mode,
              waits,
              responses: responses.map((r) => ({ status: r.status, body: r.body })),
              state,
            },
            null,
            2,
          ),
        );
      }
    },
  );

  it('propostas recíprocas simultâneas seguem a mesma ordem das contas sem deadlock', async () => {
    const a = await actor();
    const b = await actor();
    const { responses } = await simultaneous(a, [
      () => propose(a, b, 'credits'),
      () => propose(b, a, 'credits'),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
  });

  it('a falta de saldo não deixa proposta parcial ocupando o par', async () => {
    const client = await actor();
    const freelancer = await actor();
    await pool.query('UPDATE wallets SET balance=0 WHERE user_id=:id', { id: client.id });
    await propose(client, freelancer).expect(402);
    expect((await snapshot(client)).contracts).toEqual([]);
    await propose(client, freelancer, 'credits').expect(201);
  });

  it('cancelamento e nova proposta simultâneos não invertem as travas nem duplicam a reserva', async () => {
    const client = await actor();
    const freelancer = await actor();
    const first = await propose(client, freelancer).expect(201);
    const { responses, waits } = await simultaneous(client, [
      () => propose(client, freelancer),
      () => request(app).post(`/api/contracts/${first.body.id}/cancel`).set(auth(client)),
    ]);
    const [creation, cancellation] = responses;
    expect(cancellation!.status, JSON.stringify(cancellation!.body)).toBe(200);
    expect([201, 409]).toContain(creation!.status);
    if (creation!.status === 409) {
      expect(creation!.body).toMatchObject({
        error: 'active_contract_exists',
        contractId: first.body.id,
      });
      await propose(client, freelancer).expect(201);
    }
    const state = await snapshot(client);
    expect(state.contracts.map((c) => c.status)).toEqual(['cancelled', 'pending']);
    expect(state.wallet[0]).toMatchObject({ balance: '900.00', balance_pending: '100.00' });
    expect(state.ledger).toHaveLength(3);
    expect(state.offers).toHaveLength(2);
    const directory = process.env.RN020_EVIDENCE_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'concurrent-cancellation.json'),
        JSON.stringify(
          {
            waits,
            responses: responses.map((r) => ({ status: r.status, body: r.body })),
            state,
          },
          null,
          2,
        ),
      );
    }
  });

  it('a montagem de legado restaura estado e financeiro exatos quando a criação falha', async () => {
    const client = await actor();
    const freelancer = await actor();
    const first = await propose(client, freelancer).expect(201);
    await pool.query("UPDATE contracts SET updated_at='2025-01-02 03:04:05' WHERE id=:id", {
      id: first.body.id,
    });
    const before = await snapshot(client);
    await expect(
      withLegacyParallelContracts(client.id, freelancer.id, async () => {
        expect((await snapshot(client)).contracts[0]!.status).toBe('completed');
        throw new Error('falha intencional na fixture');
      }),
    ).rejects.toThrow('falha intencional na fixture');
    expect(await snapshot(client)).toEqual(before);
    await propose(client, freelancer).expect(409);
  });
});
