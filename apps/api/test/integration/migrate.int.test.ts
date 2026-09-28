import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appliedMigrations, migrate, seedReferenceIfEmpty } from '../../src/scripts/migrate-core';

/**
 * Runner de migrations num banco vazio: baseline, migrations em ordem (com as dos prazos de dia,
 * 0027 e 0028), idempotência e o seed de referência carregado uma vez só.
 */

const cfg = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? 'escambo_root',
};
// Banco próprio, derivado do banco da suíte: duas suítes com TEST_DB_NAME diferentes podem rodar
// ao mesmo tempo na mesma máquina sem uma derrubar o banco da outra.
const DB = `${process.env.DB_NAME ?? 'escambo_test'}_migtest`;

/** Prazos de dia (ADR 57): as duas migrations e o que cada uma cria. */
const DEADLINE_MIGRATIONS = ['0027_prazos_contratos', '0028_prazos_marcos'];

let conn: Connection;

async function dropDb(): Promise<void> {
  const admin = await mysql.createConnection(cfg);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
}

beforeAll(async () => {
  await dropDb();
  const admin = await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();
  conn = await mysql.createConnection({ ...cfg, database: DB, multipleStatements: true });
});

afterAll(async () => {
  await conn.end();
  await dropDb();
});

describe('runner de migrations', () => {
  it('aplica o baseline num banco vazio e registra em schema_migrations', async () => {
    const result = await migrate(conn);

    expect(result.applied).toContain('0000_baseline');
    expect(result.applied).toEqual(expect.arrayContaining(DEADLINE_MIGRATIONS));

    const [tables] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name = 'users'`,
      [DB],
    );
    expect(tables[0]!.n).toBe(1);

    const done = await appliedMigrations(conn);
    expect(done.has('0000_baseline')).toBe(true);
  });

  it('é idempotente: rodar de novo não reaplica nada', async () => {
    const result = await migrate(conn);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('0000_baseline');
    expect(result.skipped).toEqual(expect.arrayContaining(DEADLINE_MIGRATIONS));
  });

  it('0027 e 0028 (prazos de dia, ADR 57): pedido com "closed" no ENUM e as colunas novas', async () => {
    const done = await appliedMigrations(conn);
    for (const name of DEADLINE_MIGRATIONS) expect(done.has(name), name).toBe(true);

    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS tbl, column_name AS col, column_type AS type,
              is_nullable AS nullable, column_default AS def
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name IN ('contracts', 'contract_milestones')`,
      [DB],
    );
    const column = (tbl: string, col: string) =>
      rows.find((r) => r.tbl === tbl && r.col === col) as
        { type: string; nullable: string; def: string | null } | undefined;

    // Membros novos no fim do ENUM: os antigos mantêm a posição.
    expect(column('contracts', 'extension_status')).toMatchObject({
      type: "enum('none','pending','accepted','declined','expired','closed')",
      nullable: 'NO',
      def: 'none',
    });
    // Contador de pedidos (RN-028): zero nas linhas antigas; o reparo acerta o que precisa.
    expect(column('contracts', 'extension_requests')).toMatchObject({ nullable: 'NO', def: '0' });
    expect(column('contracts', 'extension_requests')?.type).toMatch(/^tinyint(\(\d+\))? unsigned$/);
    // Instantes gravados: nulos nas linhas antigas, preenchidos pelo reparo.
    for (const [tbl, col] of [
      ['contracts', 'extension_respond_by'],
      ['contracts', 'grace_ends_at'],
      ['contracts', 'approval_due_at'],
      ['contracts', 'proposal_expires_at'],
      ['contract_milestones', 'approval_due_at'],
    ] as const) {
      expect(column(tbl, col), `${tbl}.${col}`).toMatchObject({
        type: 'datetime',
        nullable: 'YES',
        def: null,
      });
    }

    // Os índices que os jobs usam para achar o que venceu.
    const [indexes] = await conn.query<RowDataPacket[]>(
      `SELECT DISTINCT table_name AS tbl, index_name AS idx
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name IN ('contracts', 'contract_milestones')`,
      [DB],
    );
    const names = indexes.map((r) => `${r.tbl}.${r.idx}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'contracts.idx_contract_status_grace',
        'contracts.idx_contract_status_approval',
        'contracts.idx_contract_status_proposal',
        'contracts.idx_contract_extension_respond',
        'contract_milestones.idx_milestone_status_approval',
      ]),
    );
  });

  it('carrega o seed de referência só quando o catálogo está vazio', async () => {
    expect(await seedReferenceIfEmpty(conn)).toBe(true);
    const [cats] = await conn.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM service_categories',
    );
    expect(Number(cats[0]!.n)).toBeGreaterThan(0);
    const [settings] = await conn.query<RowDataPacket[]>(
      "SELECT value FROM platform_settings WHERE key_name = 'platform_fee_percentage'",
    );
    expect(settings[0]!.value).toBe('15');

    // Segunda chamada não reaplica (não sobrescreve o que o admin tenha alterado).
    await conn.query(
      "UPDATE platform_settings SET value = '12' WHERE key_name = 'platform_fee_percentage'",
    );
    expect(await seedReferenceIfEmpty(conn)).toBe(false);
    const [after] = await conn.query<RowDataPacket[]>(
      "SELECT value FROM platform_settings WHERE key_name = 'platform_fee_percentage'",
    );
    expect(after[0]!.value).toBe('12');
  });
});
