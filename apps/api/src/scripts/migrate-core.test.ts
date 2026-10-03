import { basename, dirname, join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appliedMigrations,
  ensureMigrationsTable,
  loadMigrations,
  migrate,
  seedReferenceIfEmpty,
} from './migrate-core';

const fs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('node:fs', () => ({ ...fs, default: fs }));

/** Onde o runner procura os arquivos: apps/api/db (o mesmo caminho em src/ e em dist/). */
const DB_DIR = join(__dirname, '..', '..', 'db');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

const BASELINE_SQL = 'CREATE TABLE users (id INT);';
const M1_SQL = 'ALTER TABLE users ADD COLUMN nickname VARCHAR(40);';
const M2_SQL = 'CREATE INDEX idx_a ON users (nickname);';
// sha256 de cada instrução acima, calculado fora do teste.
const BASELINE_SHA = '5ea918fac5561634f4b577815b41483e5882b9c57dd3bd2351e3422d641af545';
const M1_SHA = '7212a8b9ba9a0ef1b7a36e7c83d86b161114fd9b7d570de7e9e2a245e5b52b40';
const M2_SHA = '74ae5451dbc36d83a6d7aaeac19c7bcf1eec2b17a679678090b8e1a32621c4dc';

const RECORD_SQL = 'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)';

interface Disk {
  schema?: string;
  seed?: string;
  /** Arquivos de db/migrations, na ordem em que o sistema os devolve; null = a pasta não existe. */
  migrations?: Record<string, string> | null;
}

/** Monta o "disco" que o runner enxerga: db/schema.sql, db/seed.sql e db/migrations. */
function mountDisk(disk: Disk): void {
  const migrations = disk.migrations ?? null;
  fs.existsSync.mockImplementation(
    (path: string) => path === MIGRATIONS_DIR && migrations !== null,
  );
  fs.readdirSync.mockImplementation((path: string) => {
    if (path !== MIGRATIONS_DIR || migrations === null) throw new Error(`ENOENT: ${path}`);
    return Object.keys(migrations);
  });
  fs.readFileSync.mockImplementation((path: string, encoding: string) => {
    if (encoding !== 'utf8') throw new Error(`leitura sem utf8: ${path}`);
    if (path === join(DB_DIR, 'schema.sql') && disk.schema !== undefined) return disk.schema;
    if (path === join(DB_DIR, 'seed.sql') && disk.seed !== undefined) return disk.seed;
    const file = migrations?.[basename(path)];
    if (dirname(path) === MIGRATIONS_DIR && file !== undefined) return file;
    throw new Error(`ENOENT: ${path}`);
  });
}

interface DbState {
  /** Nomes já registrados em schema_migrations. */
  applied?: string[];
  /** A tabela `users` já existe (banco criado pelo init do Docker). */
  hasUsers?: boolean;
  /** Já há categorias de serviço (o seed de referência entrou). */
  hasCatalog?: boolean;
  /** Instrução que falha, com o erro. */
  failOn?: { sql: string; error: Error };
}

/** Conexão falsa: guarda cada instrução com os parâmetros e responde conforme o estado do banco. */
function fakeConn(state: DbState = {}): {
  conn: Connection;
  calls: Array<{ sql: string; params: unknown }>;
  sqls: () => string[];
} {
  const calls: Array<{ sql: string; params: unknown }> = [];
  const query = async (sql: string, params?: unknown): Promise<[unknown, unknown[]]> => {
    calls.push({ sql, params });
    if (state.failOn?.sql === sql) throw state.failOn.error;
    if (sql === 'SELECT name FROM schema_migrations') {
      return [(state.applied ?? []).map((name) => ({ name })), []];
    }
    if (sql.includes('information_schema.tables')) return [state.hasUsers ? [{ 1: 1 }] : [], []];
    if (sql === 'SELECT 1 FROM service_categories LIMIT 1') {
      return [state.hasCatalog ? [{ 1: 1 }] : [], []];
    }
    return [{ affectedRows: 0 }, []];
  };
  return { conn: { query } as unknown as Connection, calls, sqls: () => calls.map((c) => c.sql) };
}

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const TWO_MIGRATIONS = { '0001_apelido.sql': M1_SQL, '0002_indice.sql': M2_SQL };

/**
 * Runner de migrations sem banco e sem disco: o que entra na lista, em que ordem, o que é
 * executado e o que é só registrado. Uma regressão aqui reaplica migration (e quebra o deploy) ou
 * pula uma (e a API sobe contra um schema velho).
 */
describe('runner de migrations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mountDisk({ schema: BASELINE_SQL, seed: 'INSERT INTO service_categories (id) VALUES (1);' });
  });

  describe('loadMigrations', () => {
    it('o baseline é o schema.sql sem CREATE DATABASE nem USE: roda no banco que a conexão escolheu', () => {
      mountDisk({
        schema: [
          '-- Escambo',
          'CREATE DATABASE IF NOT EXISTS escambo',
          '  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
          'USE escambo;',
          'CREATE TABLE users (id INT, used_at DATETIME);',
          'use escambo ;',
          'CREATE TABLE contracts (id INT);',
        ].join('\n'),
      });

      const steps = loadMigrations();

      expect(steps).toHaveLength(1);
      expect(steps[0]!.name).toBe('0000_baseline');
      expect(flat(steps[0]!.sql)).toBe(
        '-- Escambo CREATE TABLE users (id INT, used_at DATETIME); CREATE TABLE contracts (id INT);',
      );
    });

    it('depois do baseline vêm os .sql de db/migrations em ordem de nome, sem a extensão e sem o que não é .sql', () => {
      mountDisk({
        schema: BASELINE_SQL,
        migrations: {
          '0010_c.sql': 'SELECT 10;',
          'README.md': '# como escrever uma migration',
          '0002_b.sql': 'SELECT 2;',
          '0001_a.sql': 'SELECT 1;',
          '0003_d.sql.bak': 'SELECT 3;',
        },
      });

      expect(loadMigrations()).toEqual([
        { name: '0000_baseline', sql: BASELINE_SQL },
        { name: '0001_a', sql: 'SELECT 1;' },
        { name: '0002_b', sql: 'SELECT 2;' },
        { name: '0010_c', sql: 'SELECT 10;' },
      ]);
    });

    it('sem a pasta db/migrations só existe o baseline (e a pasta não é lida)', () => {
      mountDisk({ schema: BASELINE_SQL, migrations: null });

      expect(loadMigrations()).toEqual([{ name: '0000_baseline', sql: BASELINE_SQL }]);
      expect(fs.readdirSync).not.toHaveBeenCalled();
    });
  });

  describe('schema_migrations', () => {
    it('a tabela de controle é criada só se não existir, com o nome como chave e o checksum de 64 caracteres', async () => {
      const { conn, calls } = fakeConn();

      await ensureMigrationsTable(conn);

      expect(calls).toHaveLength(1);
      const sql = flat(calls[0]!.sql);
      expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS schema_migrations \(/);
      expect(sql).toContain('name VARCHAR(191) NOT NULL');
      expect(sql).toContain('checksum CHAR(64) NOT NULL');
      expect(sql).toContain('applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
      // A chave primária é o que impede registrar a mesma migration duas vezes.
      expect(sql).toContain('PRIMARY KEY (name)');
    });

    it('appliedMigrations devolve o conjunto dos nomes registrados', async () => {
      const { conn, sqls } = fakeConn({ applied: ['0000_baseline', '0001_apelido'] });

      const done = await appliedMigrations(conn);

      expect(sqls()).toEqual(['SELECT name FROM schema_migrations']);
      expect(done).toBeInstanceOf(Set);
      expect([...done]).toEqual(['0000_baseline', '0001_apelido']);
    });
  });

  describe('migrate', () => {
    it('em banco vazio aplica o baseline e cada migration em ordem, registrando cada uma logo depois de aplicar', async () => {
      mountDisk({ schema: BASELINE_SQL, migrations: TWO_MIGRATIONS });
      const { conn, calls } = fakeConn();

      const result = await migrate(conn);

      expect(result).toEqual({
        applied: ['0000_baseline', '0001_apelido', '0002_indice'],
        skipped: [],
      });
      expect(flat(calls[0]!.sql)).toMatch(/^CREATE TABLE IF NOT EXISTS schema_migrations/);
      expect(calls[1]!.sql).toBe('SELECT name FROM schema_migrations');
      // A âncora do baseline é a tabela users do banco da própria conexão.
      expect(flat(calls[2]!.sql)).toBe(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users' LIMIT 1",
      );
      expect(calls.slice(3)).toEqual([
        { sql: BASELINE_SQL, params: undefined },
        { sql: RECORD_SQL, params: ['0000_baseline', BASELINE_SHA] },
        { sql: M1_SQL, params: undefined },
        { sql: RECORD_SQL, params: ['0001_apelido', M1_SHA] },
        { sql: M2_SQL, params: undefined },
        { sql: RECORD_SQL, params: ['0002_indice', M2_SHA] },
      ]);
    });

    it('baseline que já está no banco (init do Docker) é só registrado, sem rodar de novo', async () => {
      mountDisk({ schema: BASELINE_SQL, migrations: TWO_MIGRATIONS });
      const { conn, calls, sqls } = fakeConn({ hasUsers: true });

      const result = await migrate(conn);

      expect(result).toEqual({
        applied: ['0001_apelido', '0002_indice'],
        skipped: ['0000_baseline (já presente)'],
      });
      expect(sqls()).not.toContain(BASELINE_SQL);
      expect(calls.slice(3)).toEqual([
        { sql: RECORD_SQL, params: ['0000_baseline', BASELINE_SHA] },
        { sql: M1_SQL, params: undefined },
        { sql: RECORD_SQL, params: ['0001_apelido', M1_SHA] },
        { sql: M2_SQL, params: undefined },
        { sql: RECORD_SQL, params: ['0002_indice', M2_SHA] },
      ]);
    });

    it('é idempotente: com tudo registrado não executa nem registra nada', async () => {
      mountDisk({ schema: BASELINE_SQL, migrations: TWO_MIGRATIONS });
      const { conn, sqls } = fakeConn({
        applied: ['0000_baseline', '0001_apelido', '0002_indice'],
        hasUsers: true,
      });

      const result = await migrate(conn);

      expect(result).toEqual({
        applied: [],
        skipped: ['0000_baseline', '0001_apelido', '0002_indice'],
      });
      // Só a criação da tabela de controle e a leitura dela.
      expect(sqls()).toHaveLength(2);
      expect(sqls()[1]).toBe('SELECT name FROM schema_migrations');
    });

    it('aplica só o que falta, sem tocar no que já foi registrado', async () => {
      mountDisk({ schema: BASELINE_SQL, migrations: TWO_MIGRATIONS });
      const { conn, calls } = fakeConn({ applied: ['0000_baseline', '0001_apelido'] });

      const result = await migrate(conn);

      expect(result).toEqual({
        applied: ['0002_indice'],
        skipped: ['0000_baseline', '0001_apelido'],
      });
      expect(calls.slice(2)).toEqual([
        { sql: M2_SQL, params: undefined },
        { sql: RECORD_SQL, params: ['0002_indice', M2_SHA] },
      ]);
    });

    it('migration que falha não é registrada e as seguintes não rodam: a próxima execução retoma dela', async () => {
      mountDisk({ schema: BASELINE_SQL, migrations: TWO_MIGRATIONS });
      const boom = new Error("Duplicate column name 'nickname'");
      const { conn, calls, sqls } = fakeConn({
        applied: ['0000_baseline'],
        failOn: { sql: M1_SQL, error: boom },
      });

      await expect(migrate(conn)).rejects.toBe(boom);

      expect(calls.at(-1)).toEqual({ sql: M1_SQL, params: undefined });
      expect(sqls()).not.toContain(RECORD_SQL);
      expect(sqls()).not.toContain(M2_SQL);
    });
  });

  describe('seedReferenceIfEmpty', () => {
    it('com o catálogo vazio carrega o seed sem o USE e avisa que carregou', async () => {
      mountDisk({
        seed: "USE escambo;\nINSERT INTO service_categories (id, name) VALUES (1, 'Design');",
      });
      const { conn, calls } = fakeConn({ hasCatalog: false });

      expect(await seedReferenceIfEmpty(conn)).toBe(true);

      expect(calls).toHaveLength(2);
      expect(calls[0]!.sql).toBe('SELECT 1 FROM service_categories LIMIT 1');
      expect(flat(calls[1]!.sql)).toBe(
        "INSERT INTO service_categories (id, name) VALUES (1, 'Design');",
      );
    });

    it('com o catálogo já carregado não roda o seed de novo (sobrescreveria o que o admin mudou)', async () => {
      const { conn, sqls } = fakeConn({ hasCatalog: true });

      expect(await seedReferenceIfEmpty(conn)).toBe(false);

      expect(sqls()).toEqual(['SELECT 1 FROM service_categories LIMIT 1']);
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });
});
