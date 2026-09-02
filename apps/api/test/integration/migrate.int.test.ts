import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appliedMigrations, migrate } from '../../src/scripts/migrate-core';

const cfg = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? 'escambo_root',
};
const DB = 'escambo_migtest';

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
  });
});
