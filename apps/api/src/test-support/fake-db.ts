import { vi } from 'vitest';

/**
 * Banco falso para os testes de unidade dos repositories (sem MySQL): guarda cada instrução com os
 * parâmetros e responde com as respostas enfileiradas, na ordem. O que o repository faz com o
 * resultado (mapear linhas, ler `affectedRows`, abrir e fechar transação) é o que o teste confere;
 * se o SQL roda de verdade é assunto dos testes de integração, contra o MySQL real.
 *
 * Uso, no arquivo de teste:
 *
 *   vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
 *   import { fakeDb } from '../../test-support/fake-db';
 *   beforeEach(() => fakeDb.reset());
 *
 *   fakeDb.reply([{ id: 1 }]);              // linhas do próximo SELECT
 *   fakeDb.reply({ affectedRows: 1 });      // cabeçalho do próximo UPDATE/INSERT/DELETE
 *   fakeDb.reply(new Error('ER_DUP_ENTRY')); // a próxima instrução falha
 *   expect(fakeDb.calls[0].sql).toContain('FROM reviews WHERE id = :id');
 *   expect(fakeDb.calls[0].params).toEqual({ id: 1 });
 */
export interface DbCall {
  /** A instrução com os espaços e quebras de linha reduzidos a um espaço. */
  sql: string;
  params: unknown;
}

const calls: DbCall[] = [];
const replies: unknown[] = [];

const query = vi.fn(async (sql: string, params?: unknown): Promise<[unknown, unknown[]]> => {
  calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  // Sem resposta enfileirada: SELECT vazio. Serve também de cabeçalho com tudo indefinido.
  const next = replies.length > 0 ? replies.shift() : [];
  if (next instanceof Error) throw next;
  return [next, []];
});

const conn = {
  query,
  execute: query,
  beginTransaction: vi.fn(async () => undefined),
  commit: vi.fn(async () => undefined),
  rollback: vi.fn(async () => undefined),
  release: vi.fn(),
};

const pool = {
  query,
  execute: query,
  getConnection: vi.fn(async () => conn),
};

/** A mesma semântica de config/db.ts: commit no fim, rollback se o trabalho falhar. */
async function inTransaction<T>(work: (c: typeof conn) => Promise<T>): Promise<T> {
  await conn.beginTransaction();
  try {
    const out = await work(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export const fakeDb = {
  /** Instruções executadas, na ordem (pelo pool e pela conexão da transação). */
  calls,
  /** A conexão que `pool.getConnection()` e `inTransaction` entregam (para conferir commit/rollback). */
  conn,
  pool,
  /** Enfileira as respostas das próximas instruções. */
  reply(...results: unknown[]): void {
    replies.push(...results);
  },
  /** Só as instruções, para conferir a ordem. */
  sqls(): string[] {
    return calls.map((c) => c.sql);
  },
  reset(): void {
    calls.length = 0;
    replies.length = 0;
    for (const fn of [
      query,
      conn.beginTransaction,
      conn.commit,
      conn.rollback,
      conn.release,
      pool.getConnection,
    ]) {
      fn.mockClear();
    }
  },
};

/** O que entra no lugar de `config/db` (ver o uso no topo). */
export const dbModule = {
  pool,
  inTransaction,
  pingDb: vi.fn(async () => undefined),
};
