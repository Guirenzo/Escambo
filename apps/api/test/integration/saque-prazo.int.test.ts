import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { settingsService } from '../../src/modules/settings/settings.service';
import { businessDueAt } from '../../src/utils/business-days';
import { setClockForTests } from '../../src/utils/clock';
import { verifyCpfOf } from './cpf.helpers';
import { verifyEmailOf } from './mail.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Prazo de saque (RN-035, RF-046, RF-078) contra o MySQL real: o prazo é gravado no pedido conforme
 * a forma de recebimento e o parâmetro que valia, a fila do admin vem pelo prazo e marca os
 * atrasados, as métricas os contam, e a migration 0036 preenche os saques abertos antigos com a
 * mesma conta do código.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer', admin = false): Promise<Actor> {
  const email = `saque_prazo_${role}_${Date.now()}_${seq++}@${admin ? 'admin.' : ''}escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const put = (token: string, key: string, value: unknown) =>
  request(app).put(`/api/admin/settings/${key}`).set(auth(token)).send({ value });

/** Sexta, 23/10/2026, 15:00 de Brasília: PIX (1 dia útil) vence na segunda, TED (2) na terça. */
const FRIDAY = new Date('2026-10-23T18:00:00.000Z');
const PIX_DUE = '2026-10-27T02:59:59.000Z'; // seg, 26/10, 23:59:59 de Brasília
const BANK_DUE = '2026-10-28T02:59:59.000Z'; // ter, 27/10
const PIX3_DUE = '2026-10-29T02:59:59.000Z'; // qua, 28/10 (depois de o admin pôr 3 dias úteis)

let admin: Actor;
let freelancer: Actor;
const ids = { bank: 0, pix: 0, pix3: 0 };

async function ask(body: Record<string, unknown>): Promise<{ id: number; dueAt: string }> {
  const res = await request(app).post('/api/withdrawals').set(auth(freelancer.token)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function storedDue(id: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT due_at FROM withdrawals WHERE id = :id`,
    { id },
  );
  return rows[0]!.due_at ? new Date(rows[0]!.due_at).toISOString() : null;
}

/** A fila "open" do admin, só com os saques deste teste, na ordem em que veio. */
async function myQueue(
  status = 'open',
): Promise<{ id: number; dueAt: string; overdue: boolean }[]> {
  const res = await request(app)
    .get(`/api/admin/withdrawals?status=${status}`)
    .set(auth(admin.token))
    .expect(200);
  return res.body.filter((w: { userId: number }) => w.userId === freelancer.id);
}

const overdueMetric = async (): Promise<number> =>
  (await request(app).get('/api/admin/metrics').set(auth(admin.token)).expect(200)).body
    .overdueWithdrawals;

/** A mesma conta das métricas, direto no banco, no instante dado. */
async function overdueInDb(at: Date): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM withdrawals
      WHERE status IN ('requested', 'processing') AND due_at < :at`,
    { at },
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  admin = await registerAndLogin('client', true);
  freelancer = await registerAndLogin('freelancer');
  // Depositar e sacar exigem e-mail confirmado (RF-006): confirma antes de pôr dinheiro na carteira.
  await verifyEmailOf(app, admin.token, freelancer.id);
  await fundWallet(app, freelancer.token, 600);
  await verifyCpfOf(app, freelancer.token); // saque de quem entrega trabalho pede o CPF validado (RF-020)
});

afterEach(() => setClockForTests(null));

afterAll(async () => {
  // Se um teste caiu no meio, os prazos voltam ao padrão da RN-035 para os próximos arquivos.
  await pool.query(
    `UPDATE platform_settings
        SET value = IF(key_name = 'withdrawal_pix_business_days', '1', '2')
      WHERE key_name IN ('withdrawal_pix_business_days', 'withdrawal_bank_business_days')`,
  );
  settingsService.clearCache();
  await pool.end();
});

describe('prazo do saque (RN-035)', () => {
  it('o pedido grava o prazo conforme o método: PIX em 1 dia útil, transferência em 2', async () => {
    setClockForTests(FRIDAY);
    const bank = await ask({
      amount: 100,
      method: 'bank',
      bankName: 'Banco do Brasil',
      bankAgency: '0001',
      bankAccount: '12345-6',
    });
    const pix = await ask({ amount: 50, method: 'pix', pixKey: 'prazo@escambo.test' });
    ids.bank = bank.id;
    ids.pix = pix.id;

    // Sexta: o fim de semana não conta.
    expect(pix.dueAt).toBe(PIX_DUE);
    expect(bank.dueAt).toBe(BANK_DUE);
    expect(await storedDue(pix.id)).toBe(PIX_DUE);
    expect(await storedDue(bank.id)).toBe(BANK_DUE);

    // A lista do titular devolve o mesmo prazo.
    const list = await request(app).get('/api/withdrawals').set(auth(freelancer.token)).expect(200);
    const due = Object.fromEntries(
      list.body.items.map((w: { id: number; dueAt: string }) => [w.id, w.dueAt]),
    );
    expect(due).toMatchObject({ [pix.id]: PIX_DUE, [bank.id]: BANK_DUE });
  });

  it('o parâmetro alterado pelo admin vale para os próximos pedidos, e não para os já feitos', async () => {
    setClockForTests(FRIDAY);
    // Fora dos limites (1 a 10 dias úteis) é 422 e nada muda.
    for (const value of [0, 11, 1.5]) {
      const res = await put(admin.token, 'withdrawal_pix_business_days', value).expect(422);
      expect(res.body.error).toBe('value_out_of_range');
    }
    await request(app)
      .put('/api/admin/settings/withdrawal_pix_business_days')
      .set(auth(freelancer.token))
      .send({ value: 3 })
      .expect(403);

    const saved = await put(admin.token, 'withdrawal_pix_business_days', 3).expect(200);
    expect(saved.body).toMatchObject({
      key: 'withdrawal_pix_business_days',
      value: 3,
      defaultValue: 1,
      min: 1,
      max: 10,
      unit: 'dias úteis',
    });
    const pub = await request(app).get('/api/settings/public').expect(200);
    expect(pub.body.withdrawalBusinessDays).toEqual({ pix: 3, bank: 2 });

    const pix3 = await ask({ amount: 30, method: 'pix', pixKey: 'prazo3@escambo.test' });
    ids.pix3 = pix3.id;
    expect(pix3.dueAt).toBe(PIX3_DUE);

    // O saque pedido antes continua com o prazo de quando foi pedido.
    expect(await storedDue(ids.pix)).toBe(PIX_DUE);
    expect(await storedDue(ids.bank)).toBe(BANK_DUE);

    await put(admin.token, 'withdrawal_pix_business_days', 1).expect(200);
    expect(await storedDue(ids.pix3)).toBe(PIX3_DUE);
  });

  it('a fila do admin vem pelo prazo e marca os atrasados; as métricas contam os mesmos', async () => {
    // Antes de vencer: nada atrasado, e a ordem é a do prazo (não a do pedido).
    setClockForTests(FRIDAY, { frozen: true });
    let queue = await myQueue();
    expect(queue.map((w) => w.id)).toEqual([ids.pix, ids.bank, ids.pix3]);
    expect(queue.map((w) => w.overdue)).toEqual([false, false, false]);

    // Um segundo depois do prazo do PIX: só ele está atrasado.
    const afterPix = new Date('2026-10-27T03:00:00.000Z');
    setClockForTests(afterPix, { frozen: true });
    queue = await myQueue();
    expect(queue.map((w) => [w.id, w.overdue])).toEqual([
      [ids.pix, true],
      [ids.bank, false],
      [ids.pix3, false],
    ]);
    const atPix = await overdueMetric();
    expect(atPix).toBe(await overdueInDb(afterPix));
    expect(atPix).toBeGreaterThanOrEqual(1);

    // No último segundo do prazo da transferência ela ainda não está atrasada; um segundo depois, sim.
    setClockForTests(new Date(BANK_DUE), { frozen: true });
    expect((await myQueue()).find((w) => w.id === ids.bank)?.overdue).toBe(false);
    const afterBank = new Date('2026-10-28T03:00:00.000Z');
    setClockForTests(afterBank, { frozen: true });
    queue = await myQueue();
    expect(queue.map((w) => w.overdue)).toEqual([true, true, false]);
    const atBank = await overdueMetric();
    expect(atBank).toBe(await overdueInDb(afterBank));

    // Em processamento continua atrasado; pago sai da conta (e da fila de abertos) na hora.
    await request(app)
      .post(`/api/admin/withdrawals/${ids.bank}/process`)
      .set(auth(admin.token))
      .expect(200);
    expect((await myQueue()).find((w) => w.id === ids.bank)?.overdue).toBe(true);
    expect(await overdueMetric()).toBe(atBank);

    const done = await request(app)
      .post(`/api/admin/withdrawals/${ids.pix}/complete`)
      .set(auth(admin.token))
      .send({ gatewayRef: 'PRAZO-1' })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'completed', overdue: false, dueAt: PIX_DUE });
    expect(await overdueMetric()).toBe(atBank - 1);
    expect((await myQueue()).map((w) => w.id)).toEqual([ids.bank, ids.pix3]);

    // Na fila completa o pago mantém o prazo gravado e não é atrasado.
    const all = await myQueue('all');
    expect(all.find((w) => w.id === ids.pix)).toMatchObject({ dueAt: PIX_DUE, overdue: false });

    // Cancelado também sai: o titular desiste do PIX de 3 dias.
    setClockForTests(new Date('2026-10-30T12:00:00.000Z'), { frozen: true });
    const before = await overdueMetric();
    await request(app)
      .post(`/api/withdrawals/${ids.pix3}/cancel`)
      .set(auth(freelancer.token))
      .expect(200);
    expect(await overdueMetric()).toBe(before - 1);
  });
});

describe('migration 0036 (prazo dos saques abertos antigos)', () => {
  const migrationSql = readFileSync(
    join(__dirname, '../../db/migrations/0036_prazo_saque.sql'),
    'utf8',
  );
  const inserted: number[] = [];

  afterAll(async () => {
    if (inserted.length > 0) {
      await pool.query(`DELETE FROM withdrawals WHERE id IN (:inserted)`, { inserted });
    }
  });

  it('está aplicada: coluna nula, índice da fila e os dois parâmetros', async () => {
    const [done] = await pool.query<RowDataPacket[]>(
      `SELECT name FROM schema_migrations WHERE name = '0036_prazo_saque'`,
    );
    expect(done).toHaveLength(1);
    const [cols] = await pool.query<RowDataPacket[]>(
      `SELECT column_type AS type, is_nullable AS nullable FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'withdrawals' AND column_name = 'due_at'`,
    );
    expect(cols).toEqual([{ type: 'datetime', nullable: 'YES' }]);
    const [index] = await pool.query<RowDataPacket[]>(
      `SELECT column_name AS col FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
          AND index_name = 'idx_wd_status_due' ORDER BY seq_in_index`,
    );
    expect(index.map((r) => r.col)).toEqual(['status', 'due_at']);
    const [settings] = await pool.query<RowDataPacket[]>(
      `SELECT key_name, type FROM platform_settings
        WHERE key_name IN ('withdrawal_bank_business_days', 'withdrawal_pix_business_days')
        ORDER BY key_name`,
    );
    expect(settings).toEqual([
      { key_name: 'withdrawal_bank_business_days', type: 'integer' },
      { key_name: 'withdrawal_pix_business_days', type: 'integer' },
    ]);
  });

  it('rodar de novo preenche só os abertos sem prazo, com a mesma conta do código, e preserva o resto', async () => {
    const [wallets] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM wallets WHERE user_id = :userId`,
      { userId: freelancer.id },
    );
    const walletId = Number(wallets[0]!.id);
    const legacy = async (
      status: string,
      method: 'pix' | 'bank',
      createdAt: string,
      dueAt: string | null = null,
    ): Promise<number> => {
      const [res] = await pool.query<ResultSetHeader>(
        `INSERT INTO withdrawals
           (user_id, wallet_id, amount, pix_key, bank_name, bank_agency, bank_account, status,
            created_at, due_at)
         VALUES (:userId, :walletId, 10, :pixKey, :bankName, :bankAgency, :bankAccount, :status,
                 :createdAt, :dueAt)`,
        {
          userId: freelancer.id,
          walletId,
          pixKey: method === 'pix' ? 'legado@escambo.test' : null,
          bankName: method === 'bank' ? 'Banco do Brasil' : null,
          bankAgency: method === 'bank' ? '0001' : null,
          bankAccount: method === 'bank' ? '12345-6' : null,
          status,
          createdAt: new Date(createdAt),
          dueAt: dueAt ? new Date(dueAt) : null,
        },
      );
      inserted.push(res.insertId);
      return res.insertId;
    };

    const cases = [
      // [status, método, pedido em (UTC), prazo esperado]
      ['requested', 'pix', '2026-10-10T01:30:00Z', '2026-10-13T02:59:59.000Z'], // sex 22:30 → seg
      ['processing', 'bank', '2026-10-10T15:00:00Z', '2026-10-14T02:59:59.000Z'], // sáb → ter
      ['requested', 'pix', '2026-10-12T01:00:00Z', '2026-10-13T02:59:59.000Z'], // dom 22:00 → seg
      ['requested', 'bank', '2026-10-09T00:30:00Z', '2026-10-13T02:59:59.000Z'], // qui 21:30 → seg
      ['requested', 'pix', '2026-10-05T15:00:00Z', '2026-10-07T02:59:59.000Z'], // seg → ter
      ['requested', 'pix', '2026-12-31T15:00:00Z', '2027-01-02T02:59:59.000Z'], // qui → sex (1º/1)
      ['requested', 'bank', '2026-12-31T15:00:00Z', '2027-01-05T02:59:59.000Z'], // qui → seg
    ] as const;
    const open: number[] = [];
    for (const [status, method, createdAt] of cases) {
      open.push(await legacy(status, method, createdAt));
    }
    const closed = await legacy('completed', 'pix', '2026-10-05T15:00:00Z');
    const cancelled = await legacy('cancelled', 'bank', '2026-10-05T15:00:00Z');
    const kept = await legacy('requested', 'pix', '2026-10-05T15:00:00Z', '2026-11-30T12:00:00Z');

    // O admin já tinha mudado o prazo: reaplicar não volta o valor ao padrão.
    await put(admin.token, 'withdrawal_bank_business_days', 4).expect(200);

    const conn = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      multipleStatements: true,
    });
    try {
      await conn.query(migrationSql);
      await conn.query(migrationSql); // idempotente
    } finally {
      await conn.end();
    }

    for (const [index, [, method, createdAt, expected]] of cases.entries()) {
      const due = await storedDue(open[index]!);
      expect(due, `${method} pedido em ${createdAt}`).toBe(expected);
      // A conta do SQL é a mesma do código (padrões da RN-035: PIX 1, TED 2).
      expect(due).toBe(businessDueAt(new Date(createdAt), method === 'pix' ? 1 : 2).toISOString());
    }
    expect(await storedDue(closed)).toBeNull();
    expect(await storedDue(cancelled)).toBeNull();
    expect(await storedDue(kept)).toBe('2026-11-30T12:00:00.000Z');
    // Saque pedido pela API não muda.
    expect(await storedDue(ids.bank)).toBe(BANK_DUE);

    const [setting] = await pool.query<RowDataPacket[]>(
      `SELECT value, description FROM platform_settings
        WHERE key_name = 'withdrawal_bank_business_days'`,
    );
    expect(setting[0]).toMatchObject({ value: '4' });
    expect(setting[0]!.description).toContain('RN-035');
    await put(admin.token, 'withdrawal_bank_business_days', 2).expect(200);
  });
});
