import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request, { type Response } from 'supertest';
import type { RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASS = 'senha-integracao-123';
type Query = (...args: unknown[]) => Promise<unknown>;

async function esperarCondicao(check: () => Promise<boolean>, message: string): Promise<void> {
  const limite = Date.now() + 10_000;
  while (Date.now() < limite) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function deadlocks(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT AS total FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'",
  );
  expect(rows, 'métrica real de deadlocks disponível no MySQL').toHaveLength(1);
  return Number(rows[0]!.total);
}

async function salvarCorrida(evidence: Record<string, unknown>): Promise<void> {
  const directory = process.env.ADR61_BOOST_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'boost-barter.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function financeiroDaCorrida(userId: number, agreementId: number, serviceId: number) {
  const [wallet] = await pool.query<RowDataPacket[]>(
    'SELECT balance,balance_pending,credits_balance,credits_pending FROM wallets WHERE user_id=:userId',
    { userId },
  );
  const [cashLedger] = await pool.query<RowDataPacket[]>(
    'SELECT amount,pending_delta,balance_after,pending_after,reason FROM wallet_transactions WHERE user_id=:userId ORDER BY id',
    { userId },
  );
  const [creditLedger] = await pool.query<RowDataPacket[]>(
    'SELECT amount,balance_after,reason FROM credit_transactions WHERE user_id=:userId ORDER BY id',
    { userId },
  );
  const [boosts] = await pool.query<RowDataPacket[]>(
    'SELECT id,status FROM boosts WHERE service_id=:serviceId ORDER BY id',
    { serviceId },
  );
  const [contracts] = await pool.query<RowDataPacket[]>(
    'SELECT id,status FROM contracts WHERE barter_agreement_id=:agreementId ORDER BY id',
    { agreementId },
  );
  return { wallet, cashLedger, creditLedger, boosts, contracts };
}

let seq = 0;
async function freelancerComId(): Promise<{ id: number; token: string }> {
  const email = `boost_${Date.now()}_${seq++}@escambo.test`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASS, role: 'freelancer' })
    .expect(201);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASS })
    .expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function freelancer(): Promise<string> {
  return (await freelancerComId()).token;
}

/**
 * Espera até haver `n` pedidos de trava parados neste banco: é como o teste sabe que cada
 * requisição chegou ao ponto em que espera a outra, sem depender de tempo.
 */
async function esperarTravasParadas(n: number): Promise<void> {
  const limite = Date.now() + 10_000;
  for (;;) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM performance_schema.data_locks
        WHERE OBJECT_SCHEMA = DATABASE() AND LOCK_STATUS = 'WAITING'`,
    );
    const paradas = Number(rows[0]!.n);
    if (paradas >= n) return;
    if (Date.now() > limite) {
      throw new Error(`esperava ${n} pedido(s) de trava parado(s), há ${paradas}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createService(token: string, title: string, price = 100): Promise<number> {
  const res = await request(app).post('/api/services').set(auth(token)).send({
    categoryId: 10,
    title,
    description: 'Serviço de teste para impulsionamento',
    priceType: 'fixed',
    price,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function credits(token: string): Promise<number> {
  const res = await request(app).get('/api/wallet').set(auth(token));
  return res.body.credits;
}

async function planId(token: string, durationDays: number): Promise<number> {
  const res = await request(app).get('/api/boosts/plans').set(auth(token));
  const plan = (res.body as { id: number; durationDays: number }[]).find(
    (p) => p.durationDays === durationDays,
  );
  return plan!.id;
}

afterAll(async () => {
  await pool.end();
});

describe('Impulsionamento (Boosts) pago em créditos', () => {
  it('lista os planos com custo em créditos', async () => {
    const token = await freelancer();
    const res = await request(app).get('/api/boosts/plans').set(auth(token));
    expect(res.status).toBe(200);
    const p7 = (res.body as { durationDays: number; costCredits: number }[]).find(
      (p) => p.durationDays === 7,
    );
    expect(p7?.costCredits).toBe(30); // round(29.90)
  });

  it('compra debita créditos, ativa o boost e coloca o serviço no topo da busca', async () => {
    const a = await freelancer();
    await credits(a); // concede o bônus (100)
    const serviceA = await createService(a, 'BoostRank Alpha');
    const p7 = await planId(a, 7);

    const buy = await request(app)
      .post('/api/boosts')
      .set(auth(a))
      .send({ serviceId: serviceA, planId: p7 });
    expect(buy.status).toBe(201);
    expect(buy.body).toMatchObject({ serviceId: serviceA, status: 'active' });
    expect(await credits(a)).toBe(70); // 100 - 30

    const mine = await request(app).get('/api/boosts').set(auth(a));
    expect(mine.body).toHaveLength(1);

    // Um segundo serviço, mais novo, SEM boost.
    const b = await freelancer();
    await createService(b, 'BoostRank Beta');

    // Busca isolada: o impulsionado (mais antigo) vem antes do mais novo.
    const search = await request(app).get('/api/services?q=BoostRank');
    expect(search.status).toBe(200);
    const titles = (search.body.items as { title: string; boosted?: boolean }[]).map(
      (s) => s.title,
    );
    expect(titles.indexOf('BoostRank Alpha')).toBeLessThan(titles.indexOf('BoostRank Beta'));
    const alpha = (search.body.items as { title: string; boosted?: boolean }[]).find(
      (s) => s.title === 'BoostRank Alpha',
    );
    expect(alpha?.boosted).toBe(true);
  });

  it('recusa com 409 quando faltam créditos', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Sem Saldo');
    const other = await createService(f, 'BoostRank Sem Saldo 2');
    const p30 = await planId(f, 30); // custa 100 créditos

    await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p30 })
      .expect(201); // 100 -> 0
    // Outro serviço (o mesmo cairia na RN-017): agora o que barra é o saldo.
    const again = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: other, planId: p30 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('insufficient_credits');
  });

  it('RN-017: com um impulsionamento ativo no serviço, o segundo é recusado com 409 e nada é cobrado', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Ativo');
    const p7 = await planId(f, 7);

    const first = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 })
      .expect(201);
    const again = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 });

    expect(again.status).toBe(409);
    expect(again.body.error).toBe('boost_active');
    expect(again.body.message).toMatch(
      /^Este serviço já tem um impulsionamento ativo até \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}; um novo só depois que ele terminar \(RN-017\)$/,
    );
    expect(await credits(f)).toBe(70); // só a primeira compra
    const mine = await request(app).get('/api/boosts').set(auth(f));
    expect((mine.body as { id: number }[]).map((b) => b.id)).toEqual([first.body.id]);

    // Depois que o atual termina, um novo pode ser contratado.
    await pool.query(`UPDATE boosts SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = :id`, {
      id: first.body.id,
    });
    await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 })
      .expect(201);
    expect(await credits(f)).toBe(40);
  });

  it('RN-017 sem corrida: compras simultâneas do mesmo serviço criam um impulsionamento só e cobram uma vez', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Corrida');
    const p7 = await planId(f, 7); // 30 créditos: o saldo daria para três

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        request(app).post('/api/boosts').set(auth(f)).send({ serviceId: service, planId: p7 }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.error)).toEqual([
      'boost_active',
      'boost_active',
    ]);
    expect(await credits(f)).toBe(70);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM boosts WHERE service_id = :service`,
      { service },
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('RN-017 com as duas compras paradas na mesma trava: a segunda espera a primeira terminar e vê o impulsionamento dela', async () => {
    const f = await freelancerComId();
    await credits(f.token); // 100
    const service = await createService(f.token, 'BoostRank Fila');
    const p7 = await planId(f.token, 7); // 30 créditos: o saldo daria para três

    // Uma terceira conexão segura a carteira em modo compartilhado: as duas compras passam pela
    // criação da carteira e param juntas no FOR UPDATE, as duas já com a transação aberta.
    const segura = await pool.getConnection();
    try {
      await segura.beginTransaction();
      await segura.query(`SELECT credits_balance FROM wallets WHERE user_id = :id FOR SHARE`, {
        id: f.id,
      });
      const compras = [0, 1].map(() =>
        request(app)
          .post('/api/boosts')
          .set(auth(f.token))
          .send({ serviceId: service, planId: p7 })
          .then((res) => res),
      );
      await esperarTravasParadas(2);
      await segura.commit();

      const results = await Promise.all(compras);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error).toBe('boost_active');
    } finally {
      // Se algo falhou no meio, a trava não pode ficar presa na conexão que volta para o pool.
      await segura.rollback().catch(() => undefined);
      segura.release();
    }
    expect(await credits(f.token)).toBe(70);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM boosts WHERE service_id = :service`,
      { service },
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('comprar o impulsionamento do serviço pedido enquanto aceita a troca que paga a torna não dá deadlock', async () => {
    const proponente = await freelancerComId();
    const receptor = await freelancerComId(); // paga a torna no aceite e impulsiona o serviço pedido
    await credits(receptor.token); // 100 créditos
    await fundWallet(app, receptor.token, 100); // R$ 100 para a torna
    // RF-084: a troca usa o preço do catálogo (300 oferecido, 200 pedido: o receptor paga 100).
    const oferecido = await createService(proponente.token, 'BoostTroca Oferecido', 300);
    const pedido = await createService(receptor.token, 'BoostTroca Pedido', 200);
    const p7 = await planId(receptor.token, 7);
    const proposta = await request(app).post('/api/barters').set(auth(proponente.token)).send({
      receiverId: receptor.id,
      offeredServiceId: oferecido,
      requestedServiceId: pedido,
      offeredDescription: 'Ofereço o serviço de 300',
      requestedDescription: 'Quero o serviço de 200',
      estimatedValueOffered: 300,
      estimatedValueRequested: 200,
    });
    expect(proposta.status, JSON.stringify(proposta.body)).toBe(201);
    expect(proposta.body).toMatchObject({ cashPayerId: receptor.id, tornaStatus: 'pending' });

    // Só controla o retorno de queries reais. Primeiro a compra passa pelo ensure autocommit
    // e adquire users compartilhado; segura nessa fase enquanto o aceite reserva a torna.
    // Depois a compra espera a carteira do aceite no InnoDB, sem deter serviço exclusivo.
    // Segurar users do proponente já não produz essa corrida: o aceite agora o trava antes
    // da carteira. Segurar só a carteira antes do ensure pararia a compra fora da transação.
    let liberaCompra!: () => void;
    let liberaAceite!: () => void;
    const faseCompra = new Promise<void>((resolve) => {
      liberaCompra = resolve;
    });
    const faseAceite = new Promise<void>((resolve) => {
      liberaAceite = resolve;
    });
    let compraConnection: number | undefined;
    let aceiteConnection: number | undefined;
    const sqlErrors: { connectionId: number; code?: string; errno?: number }[] = [];
    const evidence: Record<string, unknown> = {
      proponenteId: proponente.id,
      receptorId: receptor.id,
      agreementId: proposta.body.id,
      serviceId: pedido,
      sqlErrors,
      deadlocksBefore: await deadlocks(),
    };
    const getConnection = pool.getConnection.bind(pool);
    const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
      const conn = await getConnection();
      const originalQuery = conn.query;
      const originalRelease = conn.release;
      const query = conn.query.bind(conn) as unknown as Query;
      const wrapped: Query = async (...args) => {
        let result: unknown;
        try {
          result = await query(...args);
        } catch (error) {
          const sqlError = error as { code?: string; errno?: number };
          sqlErrors.push({
            connectionId: conn.threadId,
            code: sqlError.code,
            errno: sqlError.errno,
          });
          throw error;
        }
        const sql = typeof args[0] === 'string' ? args[0] : '';
        const parameters = args[1] as Record<string, unknown> | undefined;
        if (
          compraConnection === undefined &&
          /\bFROM users\b[\s\S]*\bFOR SHARE\b/i.test(sql) &&
          Number(parameters?.uid) === receptor.id
        ) {
          compraConnection = conn.threadId;
          evidence.compraConnection = compraConnection;
          await faseCompra;
        }
        if (
          aceiteConnection === undefined &&
          /^\s*UPDATE wallets\b/i.test(sql) &&
          Number(parameters?.userId) === receptor.id &&
          Number(parameters?.pending) === 100 &&
          Number(parameters?.balance) === -100
        ) {
          aceiteConnection = conn.threadId;
          evidence.aceiteConnection = aceiteConnection;
          await faseAceite;
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
    try {
      const compra = request(app)
        .post('/api/boosts')
        .set(auth(receptor.token))
        .send({ serviceId: pedido, planId: p7 })
        .then((res) => res);
      work.push(compra);
      await esperarCondicao(
        async () => compraConnection !== undefined,
        'compra não adquiriu users',
      );
      const aceite = request(app)
        .post(`/api/barters/${proposta.body.id}/accept`)
        .set(auth(receptor.token))
        .then((res) => res);
      work.push(aceite);
      await esperarCondicao(
        async () => aceiteConnection !== undefined,
        'aceite não reservou a torna',
      );
      expect(compraConnection).not.toBe(aceiteConnection);
      liberaCompra();
      await esperarCondicao(async () => {
        const [waits] = await pool.query<RowDataPacket[]>(
          `SELECT rt.PROCESSLIST_ID AS requesting,bt.PROCESSLIST_ID AS blocking,
            requested.OBJECT_NAME AS table_name,requested.INDEX_NAME AS index_name,
            requested.LOCK_MODE AS lock_mode,requested.LOCK_DATA AS lock_data
           FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
           JOIN performance_schema.threads rt ON rt.THREAD_ID=w.REQUESTING_THREAD_ID
           JOIN performance_schema.threads bt ON bt.THREAD_ID=w.BLOCKING_THREAD_ID
           WHERE requested.OBJECT_SCHEMA=DATABASE() AND requested.OBJECT_NAME='wallets'
             AND rt.PROCESSLIST_ID=:compra AND bt.PROCESSLIST_ID=:aceite`,
          { compra: compraConnection, aceite: aceiteConnection },
        );
        evidence.waitsBeforeRelease = waits;
        return waits.length > 0;
      }, 'compra não esperou a carteira adquirida pelo aceite no InnoDB');
      const [locks] = await pool.query<RowDataPacket[]>(
        `SELECT t.PROCESSLIST_ID AS connection_id,l.OBJECT_NAME AS table_name,
          l.INDEX_NAME AS index_name,l.LOCK_TYPE AS lock_type,l.LOCK_MODE AS lock_mode,
          l.LOCK_STATUS AS lock_status,l.LOCK_DATA AS lock_data
         FROM performance_schema.data_locks l
         JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID
         WHERE l.OBJECT_SCHEMA=DATABASE() AND t.PROCESSLIST_ID IN (:connections)
         ORDER BY t.PROCESSLIST_ID,l.OBJECT_NAME,l.INDEX_NAME,l.LOCK_DATA`,
        { connections: [compraConnection, aceiteConnection] },
      );
      evidence.locksBeforeRelease = locks;
      expect(
        locks.some(
          (lock) =>
            Number(lock.connection_id) === aceiteConnection &&
            lock.table_name === 'wallets' &&
            lock.lock_type === 'RECORD' &&
            lock.lock_status === 'GRANTED' &&
            /^X(?:,|$)/.test(String(lock.lock_mode)),
        ),
      ).toBe(true);
      expect(
        locks.filter(
          (lock) =>
            Number(lock.connection_id) === compraConnection &&
            lock.table_name === 'services' &&
            lock.lock_type === 'RECORD' &&
            /^X(?:,|$)/.test(String(lock.lock_mode)),
        ),
        'a compra não pode segurar o serviço exclusivo esperando a carteira',
      ).toEqual([]);
      liberaAceite();

      const [aceitou, comprou] = await Promise.all([aceite, compra]);
      expect(aceitou.status, JSON.stringify(aceitou.body)).toBe(200);
      expect(aceitou.body).toMatchObject({ status: 'active', tornaStatus: 'held' });
      expect(comprou.status, JSON.stringify(comprou.body)).toBe(201);
      expect(comprou.body).toMatchObject({ serviceId: pedido, status: 'active' });
    } finally {
      liberaCompra();
      liberaAceite();
      const results = await Promise.allSettled(work);
      spy.mockRestore();
      evidence.responses = results.map((result) =>
        result.status === 'fulfilled'
          ? { status: result.value.status, body: result.value.body }
          : { status: 0, error: String(result.reason) },
      );
      evidence.deadlocksAfter = await deadlocks();
      await salvarCorrida(evidence);
    }
    const carteira = await request(app).get('/api/wallet').set(auth(receptor.token));
    expect(carteira.body).toMatchObject({ credits: 70, balance: 0, balancePending: 100 });
    expect(sqlErrors).toEqual([]);
    expect(evidence.deadlocksAfter).toBe(evidence.deadlocksBefore);
    const financial = await financeiroDaCorrida(receptor.id, proposta.body.id, pedido);
    expect(financial.boosts).toHaveLength(1);
    expect(financial.contracts).toHaveLength(2);
    expect(financial.contracts.every((contract) => contract.status === 'accepted')).toBe(true);
    expect(
      financial.cashLedger.map((entry) => ({
        amount: Number(entry.amount),
        pending: Number(entry.pending_delta),
        reason: entry.reason,
      })),
    ).toEqual([
      { amount: 100, pending: 0, reason: 'deposit' },
      { amount: -100, pending: 100, reason: 'barter_hold' },
    ]);
    expect(
      financial.creditLedger.map((entry) => ({
        amount: Number(entry.amount),
        after: Number(entry.balance_after),
        reason: entry.reason,
      })),
    ).toEqual([
      { amount: 100, after: 100, reason: 'welcome' },
      { amount: -30, after: 70, reason: 'boost' },
    ]);
    await request(app)
      .post(`/api/barters/${proposta.body.id}/accept`)
      .set(auth(receptor.token))
      .expect(409);
    const repeat = await request(app)
      .post('/api/boosts')
      .set(auth(receptor.token))
      .send({ serviceId: pedido, planId: p7 })
      .expect(409);
    expect(repeat.body.error).toBe('boost_active');
    expect(await financeiroDaCorrida(receptor.id, proposta.body.id, pedido)).toEqual(financial);
    evidence.financial = financial;
    evidence.repeatedRequests = { accept: 409, boost: repeat.status, financialUnchanged: true };
    await salvarCorrida(evidence);
  });

  it('serviço pausado não é impulsionado (409 service_inactive) e nada é cobrado', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Pausado');
    await request(app)
      .patch(`/api/services/${service}`)
      .set(auth(f))
      .send({ isActive: false })
      .expect(200);
    const p7 = await planId(f, 7);

    const res = await request(app)
      .post('/api/boosts')
      .set(auth(f))
      .send({ serviceId: service, planId: p7 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('service_inactive');
    expect(await credits(f)).toBe(100);
  });

  it('não deixa impulsionar serviço de outro (403)', async () => {
    const owner = await freelancer();
    await credits(owner);
    const service = await createService(owner, 'BoostRank Alheio');
    const other = await freelancer();
    await credits(other);
    const p7 = await planId(other, 7);
    const res = await request(app)
      .post('/api/boosts')
      .set(auth(other))
      .send({ serviceId: service, planId: p7 });
    expect(res.status).toBe(403);
  });
});
