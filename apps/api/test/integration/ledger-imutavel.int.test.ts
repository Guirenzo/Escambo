import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { purgeAuditLogsOlderThan } from '../../src/modules/audit/audit.purge';
import { AUDIT_LOG_MIN_RETENTION_DAYS } from '../../src/modules/audit/audit.retention';
import { migrate } from '../../src/scripts/migrate-core';
import { fundWallet } from './wallet.helpers';

/**
 * Registro imutável das transações (RNF-036) e retenção mínima da auditoria (RNF-037) no MySQL
 * real: os triggers da migration 0046 recusam UPDATE e DELETE nos dois extratos e no histórico do
 * gateway (payment_events), e UPDATE ou DELETE recente no audit_logs, por qualquer caminho
 * (UPDATE, DELETE, ON DUPLICATE KEY, REPLACE), enquanto o INSERT dos fluxos de dinheiro continua.
 * A migration roda de novo sem erro.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const MIGRATION = join(__dirname, '..', '..', 'db', 'migrations', '0046_ledger_imutavel.sql');

const TRIGGERS = [
  ['trg_audit_logs_no_update', 'BEFORE', 'UPDATE', 'audit_logs'],
  ['trg_audit_logs_retention', 'BEFORE', 'DELETE', 'audit_logs'],
  ['trg_credit_tx_no_delete', 'BEFORE', 'DELETE', 'credit_transactions'],
  ['trg_credit_tx_no_update', 'BEFORE', 'UPDATE', 'credit_transactions'],
  ['trg_payment_events_no_delete', 'BEFORE', 'DELETE', 'payment_events'],
  ['trg_payment_events_no_update', 'BEFORE', 'UPDATE', 'payment_events'],
  ['trg_wallet_tx_no_delete', 'BEFORE', 'DELETE', 'wallet_transactions'],
  ['trg_wallet_tx_no_update', 'BEFORE', 'UPDATE', 'wallet_transactions'],
];

let seq = 0;
let user: { id: number; token: string };
/** Conexão com multipleStatements, só para rodar o arquivo da migration como o runner roda. */
let raw: Connection;

async function registerAndLogin(): Promise<{ id: number; token: string }> {
  const email = `int_ledger_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role: 'client' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

/** Os triggers das tabelas protegidas (trigger de outra tabela não entra na conta). */
async function triggers(): Promise<string[][]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
            EVENT_OBJECT_TABLE AS tbl
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND EVENT_OBJECT_TABLE IN
            ('wallet_transactions', 'credit_transactions', 'payment_events', 'audit_logs')
      ORDER BY TRIGGER_NAME`,
  );
  return rows.map((r) => [r.name, r.timing, r.event, r.tbl]);
}

/** A recusa do trigger como chega ao Node: SIGNAL 45000 vira o erro 1644 com a mensagem. */
const refused = (message: string) => ({
  errno: 1644,
  code: 'ER_SIGNAL_EXCEPTION',
  sqlState: '45000',
  sqlMessage: expect.stringContaining(message),
});

/** Uma linha do audit_logs com a idade pedida, marcada para este arquivo. */
async function auditRow(daysAgo: number): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO audit_logs (action, entity_type, created_at)
     VALUES ('test.retention', 'ledger-imutavel', NOW() - INTERVAL :daysAgo DAY)`,
    { daysAgo },
  );
  return res.insertId;
}

async function auditIds(ids: number[]): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM audit_logs WHERE id IN (:ids) ORDER BY id',
    { ids },
  );
  return rows.map((r) => Number(r.id));
}

beforeAll(async () => {
  raw = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });
  // Uma linha em cada extrato pelos fluxos de verdade: bônus de boas-vindas e depósito pago.
  user = await registerAndLogin();
  const wallet = await request(app).get('/api/wallet').set(auth(user.token));
  expect(wallet.status, JSON.stringify(wallet.body)).toBe(200);
  await fundWallet(app, user.token, 50);
});

afterAll(async () => {
  await raw.end();
  await pool.end();
});

describe('migration 0046 (RNF-036, RNF-037)', () => {
  it('entrou pelo runner, sem DELIMITER, e criou os oito triggers', async () => {
    const [applied] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM schema_migrations WHERE name = '0046_ledger_imutavel'",
    );
    expect(applied).toHaveLength(1);
    expect(await triggers()).toEqual(TRIGGERS);
  });

  it('roda duas vezes seguidas sem erro e deixa os mesmos oito triggers, ainda valendo', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    await raw.query(sql);
    await raw.query(sql);
    expect(await triggers()).toEqual(TRIGGERS);
    await expect(
      pool.query('UPDATE wallet_transactions SET amount = amount WHERE user_id = :id', {
        id: user.id,
      }),
    ).rejects.toMatchObject(refused('wallet_transactions é imutável (RNF-036)'));
    // O runner não reaplica o que já está em schema_migrations.
    expect((await migrate(raw)).skipped).toContain('0046_ledger_imutavel');
  });

  it('a definição que o mysqldump copia (SHOW CREATE TRIGGER) recria cada trigger: o backup restaurado traz a proteção', async () => {
    for (const [name] of TRIGGERS) {
      const [shown] = await raw.query<RowDataPacket[]>(`SHOW CREATE TRIGGER ${name!}`);
      const statement = String(shown[0]!['SQL Original Statement']);
      expect(statement).toMatch(new RegExp(`^CREATE DEFINER=\\S+ TRIGGER \`?${name!}\`? BEFORE`));
      await raw.query(`DROP TRIGGER ${name!}`);
      await raw.query(statement);
    }
    expect(await triggers()).toEqual(TRIGGERS);
    await expect(
      pool.query('DELETE FROM credit_transactions WHERE user_id = :id', { id: user.id }),
    ).rejects.toMatchObject(refused('credit_transactions é imutável (RNF-036)'));
  });
});

// O extrato de R$ também exige o retido resultante (pending_after), sem padrão na coluna.
describe.each([
  ['wallet_transactions', 'deposit', ', pending_after', ', 0'],
  ['credit_transactions', 'welcome', '', ''],
])('extrato %s é só INSERT (RNF-036)', (table, reason, cols, vals) => {
  const rows = async (): Promise<RowDataPacket[]> =>
    (
      await pool.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE user_id = :id ORDER BY id`, {
        id: user.id,
      })
    )[0];

  it('os fluxos de dinheiro gravaram a linha (INSERT continua liberado)', async () => {
    expect((await rows()).map((r) => r.reason)).toEqual([reason]);
  });

  it('UPDATE é recusado pelo banco e a linha fica como estava', async () => {
    const before = await rows();
    await expect(
      pool.query(`UPDATE ${table} SET amount = amount + 1 WHERE user_id = :id`, {
        id: user.id,
      }),
    ).rejects.toMatchObject(refused(`${table} é imutável (RNF-036): lançamento não se altera`));
    expect(await rows()).toEqual(before);
  });

  it('DELETE é recusado pelo banco e a linha continua lá', async () => {
    const before = await rows();
    await expect(
      pool.query(`DELETE FROM ${table} WHERE user_id = :id`, { id: user.id }),
    ).rejects.toMatchObject(refused(`${table} é imutável (RNF-036): lançamento não se apaga`));
    expect(await rows()).toEqual(before);
  });

  it('nem por ON DUPLICATE KEY UPDATE nem por REPLACE (que apaga e regrava) a linha muda', async () => {
    const [before] = await rows();
    const id = Number(before!.id);
    await expect(
      pool.query(
        `INSERT INTO ${table} (id, user_id, amount, balance_after${cols}, reason)
         VALUES (:id, :userId, 0, 0${vals}, 'x') ON DUPLICATE KEY UPDATE reason = 'adulterado'`,
        { id, userId: user.id },
      ),
    ).rejects.toMatchObject(refused('lançamento não se altera'));
    await expect(
      pool.query(
        `REPLACE INTO ${table} (id, user_id, amount, balance_after${cols}, reason)
         VALUES (:id, :userId, 0, 0${vals}, 'adulterado')`,
        { id, userId: user.id },
      ),
    ).rejects.toMatchObject(refused('lançamento não se apaga'));
    expect(await rows()).toEqual([before]);
  });

  it('a recusa dentro de uma transação desfaz o comando, e o rollback fecha o resto sem sobra', async () => {
    const before = await rows();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO ${table} (user_id, amount, balance_after${cols}, reason)
         VALUES (:userId, 1, 1${vals}, 'test.inside_tx')`,
        { userId: user.id },
      );
      await expect(
        conn.query(`DELETE FROM ${table} WHERE user_id = :id`, { id: user.id }),
      ).rejects.toMatchObject(refused('lançamento não se apaga'));
      await conn.rollback();
    } finally {
      conn.release();
    }
    expect(await rows()).toEqual(before);
  });
});

describe('histórico do gateway (payment_events) é só INSERT (RNF-036)', () => {
  const events = async (): Promise<RowDataPacket[]> =>
    (
      await pool.query<RowDataPacket[]>(
        `SELECT e.* FROM payment_events e JOIN payments p ON p.id = e.payment_id
          WHERE p.payer_id = :id ORDER BY e.id`,
        { id: user.id },
      )
    )[0];

  it('a cobrança e o pagamento simulado gravaram o histórico (INSERT continua liberado)', async () => {
    expect((await events()).map((e) => e.outcome)).toEqual(['created', 'applied']);
  });

  it('UPDATE, DELETE e REPLACE são recusados pelo banco e o histórico fica como estava', async () => {
    const before = await events();
    const ids = before.map((e) => Number(e.id));
    await expect(
      pool.query("UPDATE payment_events SET outcome = 'ignored' WHERE id IN (:ids)", { ids }),
    ).rejects.toMatchObject(
      refused('payment_events é imutável (RNF-036): o histórico do gateway não se altera'),
    );
    await expect(
      pool.query('DELETE FROM payment_events WHERE id IN (:ids)', { ids }),
    ).rejects.toMatchObject(
      refused('payment_events é imutável (RNF-036): o histórico do gateway não se apaga'),
    );
    await expect(
      pool.query(
        `REPLACE INTO payment_events (id, gateway, source, outcome)
         VALUES (:id, 'adulterado', 'webhook', 'invalid')`,
        { id: ids[0] },
      ),
    ).rejects.toMatchObject(refused('o histórico do gateway não se apaga'));
    expect(await events()).toEqual(before);
  });
});

describe('audit_logs: só INSERT, e DELETE só depois da retenção mínima (RNF-037)', () => {
  it('UPDATE é recusado mesmo numa linha antiga', async () => {
    const id = await auditRow(400);
    await expect(
      pool.query("UPDATE audit_logs SET action = 'adulterado' WHERE id = :id", { id }),
    ).rejects.toMatchObject(refused('audit_logs é imutável (RNF-037)'));
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT action FROM audit_logs WHERE id = :id',
      {
        id,
      },
    );
    expect(rows).toEqual([{ action: 'test.retention' }]);
  });

  it('linha com menos de 90 dias não sai; com mais, sai', async () => {
    const recent = await auditRow(AUDIT_LOG_MIN_RETENTION_DAYS - 1);
    const old = await auditRow(AUDIT_LOG_MIN_RETENTION_DAYS + 1);
    await expect(
      pool.query('DELETE FROM audit_logs WHERE id = :id', { id: recent }),
    ).rejects.toMatchObject(
      refused('audit_logs guarda cada registro por no mínimo 90 dias (RNF-037)'),
    );
    await pool.query('DELETE FROM audit_logs WHERE id = :id', { id: old });
    expect(await auditIds([recent, old])).toEqual([recent]);
  });

  it('um expurgo escrito com prazo menor é barrado no banco e não apaga nada, nem o que já podia sair', async () => {
    const recent = await auditRow(30);
    const old = await auditRow(200);
    await expect(
      pool.query(
        "DELETE FROM audit_logs WHERE action = 'test.retention' AND created_at < NOW() - INTERVAL 7 DAY",
      ),
    ).rejects.toMatchObject(refused('no mínimo 90 dias'));
    expect(await auditIds([recent, old])).toEqual([recent, old]);
  });

  it('o expurgo do job leva só o que passou do prazo e deixa o resto', async () => {
    const kept = [await auditRow(10), await auditRow(AUDIT_LOG_MIN_RETENTION_DAYS - 1)];
    const gone = [await auditRow(AUDIT_LOG_MIN_RETENTION_DAYS + 1), await auditRow(800)];

    expect(await purgeAuditLogsOlderThan(AUDIT_LOG_MIN_RETENTION_DAYS)).toBeGreaterThanOrEqual(2);

    expect(await auditIds([...kept, ...gone])).toEqual(kept);
    await expect(purgeAuditLogsOlderThan(AUDIT_LOG_MIN_RETENTION_DAYS - 1)).rejects.toThrow(
      'menos que a retenção mínima',
    );
  });
});
