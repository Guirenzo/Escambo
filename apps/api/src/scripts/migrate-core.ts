import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';

/**
 * Runner de migrations minimalista e forward-only, sem ORM.
 *
 * - `schema.sql` é o **baseline** (migration `0000_baseline`), aplicado a bancos
 *   vazios; se as tabelas já existirem (ex.: init do Docker), o baseline é apenas
 *   registrado como aplicado — sem re-executar.
 * - `db/migrations/NNNN_descricao.sql` são as mudanças incrementais, aplicadas em
 *   ordem, cada uma registrada em `schema_migrations` (idempotente).
 *
 * A `Connection` recebida precisa ter `multipleStatements: true`.
 */

const DB_DIR = join(__dirname, '..', '..', 'db');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

export interface MigrationStep {
  name: string;
  sql: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

/** Baseline sem `CREATE DATABASE`/`USE` — roda no database já selecionado pela conexão. */
function loadBaseline(): string {
  return readFileSync(join(DB_DIR, 'schema.sql'), 'utf8')
    .replace(/CREATE DATABASE[\s\S]*?;/i, '')
    .replace(/USE\s+\w+\s*;/gi, '');
}

export function loadMigrations(): MigrationStep[] {
  const steps: MigrationStep[] = [{ name: '0000_baseline', sql: loadBaseline() }];
  if (existsSync(MIGRATIONS_DIR)) {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      steps.push({ name: f.replace(/\.sql$/, ''), sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') });
    }
  }
  return steps;
}

export async function ensureMigrationsTable(conn: Connection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       VARCHAR(191) NOT NULL,
       checksum   CHAR(64)     NOT NULL,
       applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

export async function appliedMigrations(conn: Connection): Promise<Set<string>> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name as string));
}

/** Já existe o schema base? (checa uma tabela âncora no database atual). */
async function baselinePresent(conn: Connection): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'users' LIMIT 1`,
  );
  return rows.length > 0;
}

async function record(conn: Connection, step: MigrationStep): Promise<void> {
  // Placeholder posicional (?): não depende de namedPlaceholders na conexão.
  await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [
    step.name,
    checksum(step.sql),
  ]);
}

/** Aplica todas as migrations pendentes, em ordem. Idempotente. */
export async function migrate(conn: Connection): Promise<MigrateResult> {
  await ensureMigrationsTable(conn);
  const done = await appliedMigrations(conn);
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const step of loadMigrations()) {
    if (done.has(step.name)) {
      result.skipped.push(step.name);
      continue;
    }
    // Baseline já materializado (init do Docker/CI): só registra, não re-executa.
    if (step.name === '0000_baseline' && (await baselinePresent(conn))) {
      await record(conn, step);
      result.skipped.push(`${step.name} (já presente)`);
      continue;
    }
    await conn.query(step.sql);
    await record(conn, step);
    result.applied.push(step.name);
  }
  return result;
}
