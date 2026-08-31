import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

/**
 * Setup global dos testes de integração: recria o database `escambo_test` do
 * zero e carrega schema + seed. Roda no processo principal do vitest (antes dos
 * workers), então lê as credenciais de root direto do ambiente/defaults do
 * docker-compose — independente do `test.env` (que vale só para os workers).
 */
const cfg = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.TEST_DB_USER ?? 'root',
  password: process.env.TEST_DB_PASSWORD ?? 'escambo_root',
  database: process.env.TEST_DB_NAME ?? 'escambo_test',
};

const dbDir = join(__dirname, '..', '..', 'db');

/** Aponta o schema/seed (que embutem `escambo`) para o database de teste. */
function retarget(sql: string): string {
  return sql
    .replace('CREATE DATABASE IF NOT EXISTS escambo', `CREATE DATABASE IF NOT EXISTS ${cfg.database}`)
    .replace(/USE escambo;/g, `USE ${cfg.database};`);
}

export default async function setup(): Promise<() => Promise<void>> {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    multipleStatements: true,
  });

  await conn.query(`DROP DATABASE IF EXISTS \`${cfg.database}\`;`);
  await conn.query(retarget(readFileSync(join(dbDir, 'schema.sql'), 'utf8')));
  await conn.query(retarget(readFileSync(join(dbDir, 'seed.sql'), 'utf8')));
  await conn.end();

  // Teardown: derruba o database de teste ao fim da suíte.
  return async () => {
    const admin = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\`;`);
    await admin.end();
  };
}
