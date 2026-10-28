import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A chave entra no ambiente ANTES de o app carregar o config/env: é o caminho da produção.
vi.hoisted(() => {
  process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 0x2a).toString('base64');
});

import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { buildExport } from '../../src/modules/lgpd/lgpd.export';
import { sealStoredWithdrawals } from '../../src/modules/withdrawal/withdrawal.backfill';
import {
  currentSealPrefix,
  fieldEncryptionEnabled,
  openField,
  sealField,
  setFieldKeysForTests,
} from '../../src/utils/field-crypto';
import { verifyCpfOf } from './cpf.helpers';
import { verifyEmailOf } from './mail.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Cifragem de campo (RNF-017) contra o MySQL real, com FIELD_ENCRYPTION_KEY configurada: o pedido
 * de saque grava a chave PIX e os dados bancários cifrados, o titular e o admin leem o valor certo,
 * a linha antiga em texto puro continua legível, o dado que não decifra não derruba a fila, a cópia
 * de dados (LGPD) sai legível, e o fields:encrypt cifra as linhas antigas uma vez só.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer', admin = false): Promise<Actor> {
  const email = `cifra_${role}_${Date.now()}_${seq++}@${admin ? 'admin.' : ''}escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

interface Stored extends RowDataPacket {
  id: number;
  pix_key: string | null;
  bank_name: string | null;
  bank_agency: string | null;
  bank_account: string | null;
}

/** O destino como está GRAVADO no banco, sem passar pela API. */
async function stored(id: number): Promise<Stored> {
  const [rows] = await pool.query<Stored[]>(
    `SELECT id, pix_key, bank_name, bank_agency, bank_account FROM withdrawals WHERE id = :id`,
    { id },
  );
  return rows[0]!;
}

const PIX = 'cifra-int@escambo.test';
const BANK = { bankName: 'Banco do Brasil', bankAgency: '0001', bankAccount: '12345-6' };

let admin: Actor;
let freelancer: Actor;
let walletId = 0;
const ids = { pix: 0, bank: 0, legacyPix: 0, legacyBank: 0, broken: 0, otherKey: 0 };
const inserted: number[] = [];

/** Saque antigo gravado direto no banco, como a API gravava antes da chave (ou um dado estragado). */
async function insertRaw(destination: {
  pixKey?: string | null;
  bankName?: string | null;
  bankAgency?: string | null;
  bankAccount?: string | null;
}): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO withdrawals
       (user_id, wallet_id, amount, pix_key, bank_name, bank_agency, bank_account, status, due_at)
     VALUES (:userId, :walletId, 10, :pixKey, :bankName, :bankAgency, :bankAccount, 'requested',
             '2026-10-30 02:59:59')`,
    {
      userId: freelancer.id,
      walletId,
      pixKey: destination.pixKey ?? null,
      bankName: destination.bankName ?? null,
      bankAgency: destination.bankAgency ?? null,
      bankAccount: destination.bankAccount ?? null,
    },
  );
  inserted.push(res.insertId);
  return res.insertId;
}

type AdminItem = { id: number; userId: number; destination: string; maskedDestination: string };

async function adminQueue(): Promise<Map<number, AdminItem>> {
  const res = await request(app)
    .get('/api/admin/withdrawals?status=open')
    .set(auth(admin.token))
    .expect(200);
  return new Map(
    (res.body as AdminItem[]).filter((w) => w.userId === freelancer.id).map((w) => [w.id, w]),
  );
}

async function myList(): Promise<Map<number, { maskedDestination: string; method: string }>> {
  const res = await request(app)
    .get('/api/withdrawals?limit=100')
    .set(auth(freelancer.token))
    .expect(200);
  return new Map(
    (res.body.items as { id: number; maskedDestination: string; method: string }[]).map((w) => [
      w.id,
      w,
    ]),
  );
}

beforeAll(async () => {
  expect(fieldEncryptionEnabled()).toBe(true);
  admin = await registerAndLogin('client', true);
  freelancer = await registerAndLogin('freelancer');
  // Depositar e sacar exigem e-mail confirmado (RF-006): confirma antes de pôr dinheiro na carteira.
  await verifyEmailOf(app, admin.token, freelancer.id);
  await fundWallet(app, freelancer.token, 500);
  await verifyCpfOf(app, freelancer.token); // saque de quem entrega trabalho pede o CPF validado (RF-020)
  const [wallets] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM wallets WHERE user_id = :userId`,
    { userId: freelancer.id },
  );
  walletId = Number(wallets[0]!.id);
});

afterAll(async () => {
  // As linhas gravadas à mão (legado e estragadas) saem; as pedidas pela API ficam, com o extrato.
  if (inserted.length > 0) {
    await pool.query(`DELETE FROM withdrawals WHERE id IN (:inserted)`, { inserted });
  }
  setFieldKeysForTests(null);
  delete process.env.FIELD_ENCRYPTION_KEY;
  await pool.end();
});

describe('migration 0039 (colunas do destino para o texto cifrado)', () => {
  const migrationSql = readFileSync(
    join(__dirname, '../../db/migrations/0039_cifra_destino_saque.sql'),
    'utf8',
  );
  const sizes = async (): Promise<Record<string, unknown>> => {
    const [cols] = await pool.query<RowDataPacket[]>(
      `SELECT column_name AS col, column_type AS type, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'withdrawals'
          AND column_name IN ('pix_key', 'bank_name', 'bank_agency', 'bank_account')`,
    );
    return Object.fromEntries(cols.map((c) => [c.col, `${c.type} ${c.nullable}`]));
  };

  it('está aplicada, só aumentou, e rodar de novo não muda nada', async () => {
    const [done] = await pool.query<RowDataPacket[]>(
      `SELECT name FROM schema_migrations WHERE name = '0039_cifra_destino_saque'`,
    );
    expect(done).toHaveLength(1);
    const expected = {
      pix_key: 'varchar(1100) YES',
      bank_name: 'varchar(500) YES',
      bank_agency: 'varchar(120) YES',
      bank_account: 'varchar(160) YES',
    };
    expect(await sizes()).toEqual(expected);

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
    expect(await sizes()).toEqual(expected);
  });
});

describe('saque com FIELD_ENCRYPTION_KEY (RNF-017)', () => {
  it('o pedido grava a chave PIX e os dados bancários cifrados: o banco não tem o valor', async () => {
    const pix = await request(app)
      .post('/api/withdrawals')
      .set(auth(freelancer.token))
      .send({ amount: 50, method: 'pix', pixKey: PIX });
    expect(pix.status, JSON.stringify(pix.body)).toBe(201);
    expect(pix.body).toMatchObject({ method: 'pix', maskedDestination: '••••test' });
    const bank = await request(app)
      .post('/api/withdrawals')
      .set(auth(freelancer.token))
      .send({ amount: 60, method: 'bank', ...BANK });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    expect(bank.body).toMatchObject({ method: 'bank', maskedDestination: '••••45-6' });
    ids.pix = pix.body.id;
    ids.bank = bank.body.id;

    const prefix = currentSealPrefix()!;
    const rawPix = await stored(ids.pix);
    expect(rawPix.pix_key!.startsWith(prefix)).toBe(true);
    expect(rawPix.pix_key).not.toContain('cifra-int');
    expect([rawPix.bank_name, rawPix.bank_agency, rawPix.bank_account]).toEqual([null, null, null]);

    const rawBank = await stored(ids.bank);
    expect(rawBank.pix_key).toBeNull();
    for (const [column, value] of [
      ['bank_name', BANK.bankName],
      ['bank_agency', BANK.bankAgency],
      ['bank_account', BANK.bankAccount],
    ] as const) {
      expect(rawBank[column]!.startsWith(prefix), column).toBe(true);
      expect(rawBank[column], column).not.toContain(value);
      expect(openField(rawBank[column]!)).toEqual({ ok: true, value });
    }

    // Nenhum saque dele tem o valor em texto: nem buscando por pedaço. (Só os dele: outros arquivos
    // rodam sem chave e gravam em texto puro, às vezes a mesma conta de exemplo.)
    const [hits] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM withdrawals
        WHERE user_id = :userId AND (pix_key LIKE '%cifra-int%' OR bank_account LIKE '%12345-6%')`,
      { userId: freelancer.id },
    );
    expect(Number(hits[0]!.n)).toBe(0);
  });

  it('o titular vê o destino mascarado e o admin, o valor completo para pagar', async () => {
    const mine = await myList();
    expect(mine.get(ids.pix)).toMatchObject({ method: 'pix', maskedDestination: '••••test' });
    expect(mine.get(ids.bank)).toMatchObject({ method: 'bank', maskedDestination: '••••45-6' });

    const queue = await adminQueue();
    expect(queue.get(ids.pix)!.destination).toBe(PIX);
    expect(queue.get(ids.bank)!.destination).toBe('Banco do Brasil · 0001 · 12345-6');

    // O saque aberto pelo admin (processar) devolve o destino decifrado também.
    const processed = await request(app)
      .post(`/api/admin/withdrawals/${ids.pix}/process`)
      .set(auth(admin.token))
      .expect(200);
    expect(processed.body).toMatchObject({ status: 'processing', destination: PIX });
  });

  it('linha antiga em texto puro continua legível pelo titular e pelo admin', async () => {
    ids.legacyPix = await insertRaw({ pixKey: 'legado-pix@escambo.test' });
    ids.legacyBank = await insertRaw({
      bankName: 'Itaú',
      bankAgency: '0400',
      bankAccount: '777-1',
    });

    const mine = await myList();
    expect(mine.get(ids.legacyPix)).toMatchObject({ method: 'pix', maskedDestination: '••••test' });
    expect(mine.get(ids.legacyBank)).toMatchObject({
      method: 'bank',
      maskedDestination: '••••77-1',
    });
    const queue = await adminQueue();
    expect(queue.get(ids.legacyPix)!.destination).toBe('legado-pix@escambo.test');
    expect(queue.get(ids.legacyBank)!.destination).toBe('Itaú · 0400 · 777-1');
  });

  it('valor cifrado que não decifra não derruba a fila nem a lista: vai como "[indisponível]"', async () => {
    setFieldKeysForTests({ current: Buffer.alloc(32, 0x2b).toString('base64') });
    const withOtherKey = sealField('outra-chave@escambo.test');
    setFieldKeysForTests(null); // volta à FIELD_ENCRYPTION_KEY do ambiente
    ids.otherKey = await insertRaw({ pixKey: withOtherKey });
    ids.broken = await insertRaw({ pixKey: `${currentSealPrefix()}estragado` });

    const queue = await adminQueue();
    expect(queue.get(ids.otherKey)).toMatchObject({
      destination: '[indisponível]',
      maskedDestination: '[indisponível]',
    });
    expect(queue.get(ids.broken)!.destination).toBe('[indisponível]');
    // Os outros saques da mesma fila continuam legíveis.
    expect(queue.get(ids.pix)!.destination).toBe(PIX);

    const mine = await myList();
    expect(mine.get(ids.otherKey)!.maskedDestination).toBe('[indisponível]');
  });

  it('a cópia de dados (LGPD) traz o destino legível; o ilegível sai marcado', async () => {
    const out = (await buildExport(freelancer.id)) as {
      carteira: { saques: { id: number; pix_key: string | null; bank_account: string | null }[] };
    };
    const byId = new Map(out.carteira.saques.map((w) => [w.id, w]));

    expect(byId.get(ids.pix)!.pix_key).toBe(PIX);
    expect(byId.get(ids.bank)!.bank_account).toBe(BANK.bankAccount);
    expect(byId.get(ids.legacyPix)!.pix_key).toBe('legado-pix@escambo.test');
    expect(byId.get(ids.otherKey)!.pix_key).toBe('[indisponível]');
    expect(JSON.stringify(out)).not.toContain(currentSealPrefix()!);
  });

  it('fields:encrypt cifra as linhas antigas, deixa o ilegível como está, e rodar de novo não regrava nada', async () => {
    const before = {
      pix: await stored(ids.pix),
      otherKey: await stored(ids.otherKey),
      broken: await stored(ids.broken),
    };

    const first = await sealStoredWithdrawals(2); // lote pequeno: passa por mais de uma página
    expect(first.sealed).toBeGreaterThanOrEqual(2);
    // O da chave desconhecida. O estragado tem a impressão da chave atual: o script não o lê (quem
    // lê é que descobre, e mostra "[indisponível]").
    expect(first.unreadable).toBeGreaterThanOrEqual(1);

    const prefix = currentSealPrefix()!;
    const legacyPix = await stored(ids.legacyPix);
    expect(legacyPix.pix_key!.startsWith(prefix)).toBe(true);
    expect(legacyPix.pix_key).not.toContain('legado-pix');
    const legacyBank = await stored(ids.legacyBank);
    for (const column of ['bank_name', 'bank_agency', 'bank_account'] as const) {
      expect(legacyBank[column]!.startsWith(prefix), column).toBe(true);
    }
    // O que já estava com a chave atual e o que não decifra ficaram como estavam.
    expect(await stored(ids.pix)).toEqual(before.pix);
    expect(await stored(ids.otherKey)).toEqual(before.otherKey);
    expect(await stored(ids.broken)).toEqual(before.broken);

    // E continuam legíveis pela API, agora cifradas.
    const queue = await adminQueue();
    expect(queue.get(ids.legacyPix)!.destination).toBe('legado-pix@escambo.test');
    expect(queue.get(ids.legacyBank)!.destination).toBe('Itaú · 0400 · 777-1');

    // Idempotente: a segunda rodada só reencontra o ilegível, e não regrava nada.
    const snapshot = await stored(ids.legacyPix);
    const second = await sealStoredWithdrawals();
    expect(second.sealed).toBe(0);
    expect(second.checked).toBe(second.unreadable);
    expect(await stored(ids.legacyPix)).toEqual(snapshot);
  });

  it('a API recusa destino que já chega no formato reservado dos cifrados', async () => {
    const res = await request(app)
      .post('/api/withdrawals')
      .set(auth(freelancer.token))
      .send({ amount: 30, method: 'pix', pixKey: `${currentSealPrefix()}AAAA` });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ pixKey: ['Valor inválido'] });
  });
});
