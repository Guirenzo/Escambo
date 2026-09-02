import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { migrate } from '../../src/scripts/migrate-core';

/**
 * Setup global dos testes de integração: recria o database `escambo_test` do
 * zero, aplica **baseline + migrations** (mesmo caminho da produção) e carrega o
 * seed. Roda no processo principal do vitest (antes dos workers), lendo as
 * credenciais de root direto do ambiente/defaults do docker-compose.
 */
const cfg = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.TEST_DB_USER ?? 'root',
  password: process.env.TEST_DB_PASSWORD ?? 'escambo_root',
  database: process.env.TEST_DB_NAME ?? 'escambo_test',
};

const seedPath = join(__dirname, '..', '..', 'db', 'seed.sql');

/** Aponta o `USE escambo;` do seed para o database de teste. */
const retargetSeed = (sql: string): string => sql.replace(/USE\s+escambo\s*;/gi, `USE ${cfg.database};`);

export default async function setup(): Promise<() => Promise<void>> {
  const admin = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\`;`);
  await admin.query(
    `CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  );
  await admin.end();

  const db = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
  });
  await migrate(db); // baseline (schema.sql) + migrations em ordem
  await db.query(retargetSeed(readFileSync(seedPath, 'utf8')));
  await db.end();

  // Teardown: derruba o database de teste ao fim da suíte.
  return async () => {
    const closer = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
    });
    await closer.query(`DROP DATABASE IF EXISTS \`${cfg.database}\`;`);
    await closer.end();
  };
}
