import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { env } from '../config/env';

const h = vi.hoisted(() => ({
  conn: { end: vi.fn() },
  createConnection: vi.fn(),
  poolEnd: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  runRepairDeadlines: vi.fn(),
  core: {
    appliedMigrations: vi.fn(),
    ensureMigrationsTable: vi.fn(),
    loadMigrations: vi.fn(),
    migrate: vi.fn(),
    seedReferenceIfEmpty: vi.fn(),
  },
}));
vi.mock('mysql2/promise', () => ({ default: { createConnection: h.createConnection } }));
vi.mock('../config/db', () => ({ pool: { end: h.poolEnd } }));
vi.mock('../config/logger', () => ({ logger: h.logger }));
vi.mock('../jobs/repair-deadlines', () => ({ runRepairDeadlines: h.runRepairDeadlines }));
vi.mock('./migrate-core', () => h.core);

const REPAIR = { graceWithoutNotice: 0, respondBy: 2 };
const firstCall = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]!;

/**
 * CLI de migrations (`npm run db:migrate`), com o driver, o runner e o reparo mockados: o script é
 * importado como o tsx o roda, e o que se confere é a ordem do que ele chama, o que registra e
 * como termina. É o passo do deploy que roda antes de a API nova subir.
 */
describe('CLI de migrations', () => {
  const argv = process.argv;
  let exit: MockInstance;
  let print: MockInstance;

  /** Roda `migrate.ts <args>` e espera o script terminar (pool fechado ou saída com erro). */
  async function runCli(...args: string[]): Promise<void> {
    process.argv = ['node', 'migrate.ts', ...args];
    vi.resetModules();
    await import('./migrate');
    await vi.waitFor(() => {
      expect(h.poolEnd.mock.calls.length + exit.mock.calls.length).toBeGreaterThan(0);
    });
    // Deixa o catch do script (que vem depois do finally) rodar.
    await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    print = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    h.createConnection.mockResolvedValue(h.conn);
    h.conn.end.mockResolvedValue(undefined);
    h.poolEnd.mockResolvedValue(undefined);
    h.core.migrate.mockResolvedValue({ applied: [], skipped: [] });
    h.core.seedReferenceIfEmpty.mockResolvedValue(false);
    h.runRepairDeadlines.mockResolvedValue(REPAIR);
  });
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('conecta com as credenciais da própria API, aceitando várias instruções por arquivo', async () => {
    await runCli();

    expect(h.createConnection).toHaveBeenCalledTimes(1);
    expect(h.createConnection).toHaveBeenCalledWith({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      // Sem isto o schema.sql e as migrations (várias instruções por arquivo) não rodam.
      multipleStatements: true,
    });
  });

  it('aplica as pendentes, carrega o seed, repara os prazos e fecha a conexão e o pool, nessa ordem', async () => {
    h.core.migrate.mockResolvedValue({
      applied: ['0027_prazos_contratos', '0028_prazos_marcos'],
      skipped: ['0000_baseline'],
    });
    h.core.seedReferenceIfEmpty.mockResolvedValue(true);

    await runCli();

    expect(h.core.migrate).toHaveBeenCalledWith(h.conn);
    expect(h.core.seedReferenceIfEmpty).toHaveBeenCalledWith(h.conn);
    // O reparo roda com o relógio do processo (sem hora informada) e pelo pool da API.
    expect(h.runRepairDeadlines).toHaveBeenCalledWith();
    const order = [
      h.createConnection,
      h.core.migrate,
      h.core.seedReferenceIfEmpty,
      h.runRepairDeadlines,
      h.conn.end,
      h.poolEnd,
    ].map(firstCall);
    // Todos rodaram (quem não roda não tem ordem), e nessa sequência.
    expect(order.every((n) => Number.isInteger(n))).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(h.logger.info.mock.calls).toEqual([
      [
        { aplicadas: ['0027_prazos_contratos', '0028_prazos_marcos'], ignoradas: 1 },
        'Migrations aplicadas',
      ],
      ['Seed de referência carregado (catálogo estava vazio)'],
      [{ reparo: REPAIR }, 'Prazos reparados'],
    ]);
    expect(h.conn.end).toHaveBeenCalledTimes(1);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('sem nada pendente diz que o banco já está atualizado, e não anuncia seed que não carregou', async () => {
    h.core.migrate.mockResolvedValue({ applied: [], skipped: ['0000_baseline', '0001_credits'] });

    await runCli();

    expect(h.logger.info.mock.calls).toEqual([
      [{ aplicadas: [], ignoradas: 2 }, 'Banco já está atualizado'],
      [{ reparo: REPAIR }, 'Prazos reparados'],
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('falha no reparo dos prazos não barra o deploy: avisa, fecha tudo e termina sem erro (ADR 57)', async () => {
    const boom = new Error('Lock wait timeout exceeded');
    h.runRepairDeadlines.mockRejectedValue(boom);

    await runCli();

    expect(h.logger.warn.mock.calls).toEqual([
      [{ err: boom }, 'Reparo dos prazos falhou; a próxima rodada dos jobs tenta de novo'],
    ]);
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.conn.end).toHaveBeenCalledTimes(1);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('--status só lista aplicadas e pendentes: não aplica, não carrega seed nem repara', async () => {
    h.core.appliedMigrations.mockResolvedValue(new Set(['0000_baseline', '0001_credits']));
    h.core.loadMigrations.mockReturnValue([
      { name: '0000_baseline', sql: '' },
      { name: '0001_credits', sql: '' },
      { name: '0002_pagamentos', sql: '' },
    ]);

    await runCli('--status');

    // A tabela de controle é criada antes de ser lida (banco novo não a tem).
    expect(h.core.ensureMigrationsTable).toHaveBeenCalledWith(h.conn);
    expect(firstCall(h.core.ensureMigrationsTable)).toBeLessThan(
      firstCall(h.core.appliedMigrations),
    );
    expect(h.core.appliedMigrations).toHaveBeenCalledWith(h.conn);
    expect(print.mock.calls).toEqual([
      ['✓ aplicada  0000_baseline'],
      ['✓ aplicada  0001_credits'],
      ['· pendente  0002_pagamentos'],
    ]);
    expect(h.core.migrate).not.toHaveBeenCalled();
    expect(h.core.seedReferenceIfEmpty).not.toHaveBeenCalled();
    expect(h.runRepairDeadlines).not.toHaveBeenCalled();
    expect(h.conn.end).toHaveBeenCalledTimes(1);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('migration que falha: fecha a conexão e o pool, registra o erro e sai com código 1 (o deploy para)', async () => {
    const boom = new Error("Duplicate column name 'grace_ends_at'");
    h.core.migrate.mockRejectedValue(boom);

    await runCli();

    expect(h.core.seedReferenceIfEmpty).not.toHaveBeenCalled();
    expect(h.runRepairDeadlines).not.toHaveBeenCalled();
    expect(h.conn.end).toHaveBeenCalledTimes(1);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao rodar migrations']]);
    expect(exit.mock.calls).toEqual([[1]]);
    // Fecha tudo ANTES de sair, e não anuncia migration aplicada nem prazo reparado.
    expect(firstCall(h.conn.end)).toBeLessThan(firstCall(h.poolEnd));
    expect(firstCall(h.poolEnd)).toBeLessThan(firstCall(exit));
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it('banco inalcançável: registra o erro e sai com código 1, sem tentar migrar', async () => {
    const boom = new Error('connect ECONNREFUSED');
    h.createConnection.mockRejectedValue(boom);

    await runCli();

    expect(h.core.migrate).not.toHaveBeenCalled();
    expect(h.conn.end).not.toHaveBeenCalled();
    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao rodar migrations']]);
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
