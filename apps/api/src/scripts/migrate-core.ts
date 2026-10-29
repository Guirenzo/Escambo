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
 * - `seed.sql` (catálogo de referência) entra uma única vez, quando o catálogo está
 *   vazio — é o caso da primeira subida em produção, sem o init do Docker.
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

/**
 * O mesmo arquivo pode chegar com outro fim de linha: o checkout no Windows traz CRLF, a imagem
 * construída no CI traz LF. Qualquer uma dessas variantes conta como o arquivo que foi aplicado.
 */
function checksumVariants(sql: string): string[] {
  const lf = sql.replace(/\r\n/g, '\n');
  return [checksum(sql), checksum(lf), checksum(lf.replace(/\n/g, '\r\n'))];
}

/** Baseline sem `CREATE DATABASE`/`USE` — roda no database já selecionado pela conexão. */
function loadBaseline(): string {
  return readFileSync(join(DB_DIR, 'schema.sql'), 'utf8')
    .replace(/CREATE DATABASE[\s\S]*?;/i, '')
    .replace(/USE\s+\w+\s*;/gi, '');
}

/** Seed de referência (categorias, badges, missões, planos, configurações), sem `USE`. */
function loadSeed(): string {
  return readFileSync(join(DB_DIR, 'seed.sql'), 'utf8').replace(/USE\s+\w+\s*;/gi, '');
}

export function loadMigrations(): MigrationStep[] {
  const steps: MigrationStep[] = [{ name: '0000_baseline', sql: loadBaseline() }];
  if (existsSync(MIGRATIONS_DIR)) {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      steps.push({
        name: f.replace(/\.sql$/, ''),
        sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8'),
      });
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

/** Nome e checksum de cada migration registrada em schema_migrations. */
export async function appliedChecksums(conn: Connection): Promise<Map<string, string>> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT name, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.name as string, r.checksum as string]));
}

/**
 * Migrations já aplicadas cujo arquivo mudou depois: o checksum gravado na aplicação não bate com
 * nenhuma variante do arquivo atual. Migration aplicada não se edita (o banco de quem já rodou
 * nunca veria a mudança); a correção é a próxima migration. O baseline fica de fora: o schema.sql
 * é o retrato do banco inteiro para bancos novos, não uma mudança incremental.
 */
export function changedMigrations(steps: MigrationStep[], applied: Map<string, string>): string[] {
  return steps
    .filter((step) => step.name !== '0000_baseline' && applied.has(step.name))
    .filter((step) => !checksumVariants(step.sql).includes(applied.get(step.name)!))
    .map((step) => step.name);
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

/** O catálogo de referência já foi carregado? (âncora: alguma categoria de serviço). */
async function catalogPresent(conn: Connection): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT 1 FROM service_categories LIMIT 1');
  return rows.length > 0;
}

/**
 * Carrega o seed de referência se o catálogo estiver vazio (primeira subida sem o init do
 * Docker, ex.: produção). Roda só uma vez de propósito: o seed é idempotente, mas reaplicá-lo
 * a cada subida sobrescreveria configurações que o admin tenha alterado depois.
 * Devolve `true` quando carregou.
 */
export async function seedReferenceIfEmpty(conn: Connection): Promise<boolean> {
  if (await catalogPresent(conn)) return false;
  await conn.query(loadSeed());
  return true;
}

/** ER_BINLOG_CREATE_ROUTINE_NEED_SUPER: criar trigger com o binlog ligado, sem SUPER. */
const ER_TRIGGER_NEEDS_SUPER = 1419;

/**
 * A 0046 cria triggers (RNF-036). Com o binlog ligado (padrão do MySQL 8), o usuário da aplicação
 * só consegue com log_bin_trust_function_creators=1: o erro cru do MySQL não diz onde mexer.
 * Qualquer outro erro sai como veio.
 */
function explainFailure(step: MigrationStep, err: unknown): unknown {
  if ((err as { errno?: unknown } | null)?.errno !== ER_TRIGGER_NEEDS_SUPER) return err;
  return new Error(
    `${step.name}: o MySQL recusou criar trigger porque o binlog está ligado e o usuário do banco ` +
      'não tem SUPER. Suba o MySQL com --log-bin-trust-function-creators=1 (os docker-compose já ' +
      'sobem assim; recrie o contêiner do banco) ou rode como root ' +
      '"SET PERSIST log_bin_trust_function_creators = 1", e rode as migrations de novo.',
    { cause: err },
  );
}

/**
 * Aplica todas as migrations pendentes, em ordem. Idempotente. Antes de aplicar qualquer coisa,
 * recusa se uma migration já aplicada foi editada depois (changedMigrations): rodar por cima
 * deixaria bancos diferentes com o mesmo histórico.
 */
export async function migrate(conn: Connection): Promise<MigrateResult> {
  await ensureMigrationsTable(conn);
  const applied = await appliedChecksums(conn);
  const steps = loadMigrations();
  const changed = changedMigrations(steps, applied);
  if (changed.length > 0) {
    throw new Error(
      `Migration alterada depois de aplicada: ${changed.join(', ')}. Volte o arquivo ao que foi ` +
        'aplicado (git log) e ponha a mudança numa migration nova, com a próxima numeração.',
    );
  }
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const step of steps) {
    if (applied.has(step.name)) {
      result.skipped.push(step.name);
      continue;
    }
    // Baseline já materializado (init do Docker/CI): só registra, não re-executa.
    if (step.name === '0000_baseline' && (await baselinePresent(conn))) {
      await record(conn, step);
      result.skipped.push(`${step.name} (já presente)`);
      continue;
    }
    try {
      await conn.query(step.sql);
    } catch (err) {
      throw explainFailure(step, err);
    }
    await record(conn, step);
    result.applied.push(step.name);
  }
  return result;
}
