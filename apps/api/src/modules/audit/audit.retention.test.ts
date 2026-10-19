import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOG_MIN_RETENTION_DAYS } from './audit.retention';

/**
 * Retenção da auditoria e imutabilidade dos extratos no código (RNF-036, RNF-037). O banco já
 * recusa UPDATE/DELETE nos extratos e no histórico do gateway (payment_events), e DELETE recente
 * no audit_logs (migration 0046); este teste pega antes, na revisão, quem escrever um expurgo ou
 * uma correção que dependa disso: qualquer DELETE, UPDATE, TRUNCATE, DROP TABLE ou REPLACE nas
 * tabelas protegidas, no código da API, nas migrations ou nos scripts, quebra aqui, exceto o
 * expurgo com prazo mínimo e a anonimização da LGPD (que reescreve a descrição de admin_actions).
 */

const API_DIR = join(__dirname, '..', '..', '..');
const REPO_DIR = join(API_DIR, '..', '..');

const PROTECTED = [
  'wallet_transactions',
  'credit_transactions',
  'payment_events',
  'audit_logs',
  'admin_actions',
];
const WRITE = new RegExp(
  String.raw`\b(DELETE\s+(?:\w+\s+)?FROM|UPDATE|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|REPLACE(?:\s+INTO)?)\s+` +
    '`?(' +
    PROTECTED.join('|') +
    ')\\b`?',
  'gi',
);

/** Arquivos de código sob `dir`, sem dependências, build, cobertura nem resultados de carga. */
function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage', 'resultados', 'test-support'].includes(entry.name))
        out.push(...walk(path, accept));
    } else if (accept(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function sources(): string[] {
  return [
    ...walk(join(API_DIR, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
    ...walk(join(API_DIR, 'db'), (n) => n.endsWith('.sql')),
    ...walk(join(REPO_DIR, 'scripts'), (n) => /\.(sh|mjs|js|sql)$/.test(n)),
  ];
}

/** Cada escrita encontrada: o arquivo (a partir da raiz do repositório) e o comando normalizado. */
function writesToProtectedTables(): { file: string; write: string }[] {
  const found: { file: string; write: string }[] = [];
  for (const path of sources()) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(WRITE)) {
      found.push({
        file: relative(REPO_DIR, path).split(sep).join('/'),
        write: `${m[1]!.replace(/\s+/g, ' ').toUpperCase()} ${m[2]!.toLowerCase()}`,
      });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.write.localeCompare(b.write));
}

describe('retenção da auditoria e extratos imutáveis no código (RNF-036, RNF-037)', () => {
  it('a retenção mínima é 90 dias, e o trigger da 0046 usa o mesmo número', () => {
    expect(AUDIT_LOG_MIN_RETENTION_DAYS).toBe(90);
    const migration = readFileSync(
      join(API_DIR, 'db', 'migrations', '0046_ledger_imutavel.sql'),
      'utf8',
    );
    const retention = migration.slice(migration.indexOf('CREATE TRIGGER trg_audit_logs_retention'));
    expect(retention).toMatch(
      /^CREATE TRIGGER trg_audit_logs_retention\s+BEFORE DELETE ON audit_logs/,
    );
    expect(retention.match(/INTERVAL (\d+) DAY/)?.[1]).toBe(String(AUDIT_LOG_MIN_RETENTION_DAYS));
  });

  it('o varredor enxerga as formas de apagar ou reescrever (senão o teste abaixo passaria à toa)', () => {
    const sample = [
      'DELETE FROM audit_logs WHERE 1',
      'delete t from wallet_transactions t',
      'UPDATE `credit_transactions` SET amount = 0',
      'TRUNCATE TABLE admin_actions',
      'DROP TABLE IF EXISTS audit_logs',
      'REPLACE INTO wallet_transactions VALUES ()',
      'BEFORE UPDATE ON wallet_transactions', // definição de trigger: não é escrita
      'INSERT INTO audit_logs (action) VALUES (1)',
    ].join('\n');
    expect([...sample.matchAll(WRITE)].map((m) => m[0].replace(/\s+/g, ' '))).toEqual([
      'DELETE FROM audit_logs',
      'delete t from wallet_transactions',
      'UPDATE `credit_transactions`',
      'TRUNCATE TABLE admin_actions',
      'DROP TABLE IF EXISTS audit_logs',
      'REPLACE INTO wallet_transactions',
    ]);
  });

  it('só o expurgo com prazo mínimo apaga a auditoria, e nada apaga nem reescreve os extratos', () => {
    expect(sources().length).toBeGreaterThan(100);
    expect(writesToProtectedTables()).toEqual([
      { file: 'apps/api/src/modules/audit/audit.purge.ts', write: 'DELETE FROM audit_logs' },
      { file: 'apps/api/src/modules/lgpd/lgpd.repository.ts', write: 'UPDATE admin_actions' },
    ]);
  });
});
