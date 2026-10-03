import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inTransaction, pingDb, pool } from './db';
import { env } from './env';

const { conn, fakePool, createPool } = vi.hoisted(() => {
  const conn = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
    query: vi.fn(),
  };
  const fakePool = { getConnection: vi.fn() };
  return { conn, fakePool, createPool: vi.fn((_options: Record<string, unknown>) => fakePool) };
});
vi.mock('mysql2/promise', () => ({ default: { createPool } }));

// O pool nasce na carga do módulo: guarda as opções antes de o beforeEach limpar os mocks.
const poolOptions = createPool.mock.calls[0]![0];
const poolsCreated = createPool.mock.calls.length;

/** A ordem em que os mocks foram chamados (cada um, uma vez). */
const order = (...fns: Array<{ mock: { invocationCallOrder: number[] } }>): number[] =>
  fns.map((fn) => fn.mock.invocationCallOrder[0]!);

/**
 * config/db sem MySQL (o driver é mockado): como o pool é configurado e o que `inTransaction` e
 * `pingDb` fazem com a conexão — commit, rollback e, sempre, devolver a conexão ao pool.
 */
describe('config/db', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fakePool.getConnection.mockResolvedValue(conn);
    conn.beginTransaction.mockResolvedValue(undefined);
    conn.commit.mockResolvedValue(undefined);
    conn.rollback.mockResolvedValue(undefined);
    conn.query.mockResolvedValue([[{ 1: 1 }], []]);
  });

  describe('pool', () => {
    it('é um só, com as credenciais do ambiente', () => {
      expect(poolsCreated).toBe(1);
      expect(pool).toBe(fakePool);
      expect(poolOptions).toMatchObject({
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
        connectionLimit: env.DB_CONNECTION_LIMIT,
      });
      // O vitest.config aponta para um banco que não existe: é o que mantém a suíte sem MySQL.
      expect(poolOptions).toMatchObject({ host: '127.0.0.1', port: 1 });
    });

    it('aceita :param nas queries e troca datas sempre em UTC', () => {
      // Sem namedPlaceholders, todo repository (que usa :id, :now…) quebraria.
      expect(poolOptions.namedPlaceholders).toBe(true);
      // Sem o "Z", um Date do Node em -03:00 seria gravado 3 h fora e os prazos comparariam errado.
      expect(poolOptions.timezone).toBe('Z');
    });

    it('enfileira quem pede conexão com o pool cheio, sem limite de fila, e mantém as conexões vivas', () => {
      expect(poolOptions).toMatchObject({
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      });
    });
  });

  describe('inTransaction', () => {
    it('abre a transação, entrega a conexão ao trabalho, faz commit e devolve o resultado', async () => {
      const work = vi.fn(async (_c: PoolConnection) => ({ id: 31 }));

      expect(await inTransaction(work)).toEqual({ id: 31 });

      expect(work).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledWith(conn);
      const steps = order(
        fakePool.getConnection,
        conn.beginTransaction,
        work,
        conn.commit,
        conn.release,
      );
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
      expect(conn.commit).toHaveBeenCalledTimes(1);
      expect(conn.rollback).not.toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('se o trabalho falha, desfaz tudo, não faz commit, devolve a conexão e repassa o MESMO erro', async () => {
      const boom = new Error('saldo insuficiente');

      await expect(
        inTransaction(async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(conn.commit).not.toHaveBeenCalled();
      expect(conn.rollback).toHaveBeenCalledTimes(1);
      expect(conn.release).toHaveBeenCalledTimes(1);
      const steps = order(conn.rollback, conn.release);
      expect(steps[0]).toBeLessThan(steps[1]!);
    });

    it('se o commit falha, tenta o rollback e devolve a conexão', async () => {
      const boom = new Error('deadlock no commit');
      conn.commit.mockRejectedValue(boom);

      await expect(inTransaction(async () => 'ok')).rejects.toBe(boom);

      expect(conn.rollback).toHaveBeenCalledTimes(1);
      expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('se a transação nem abre, o trabalho não roda e a conexão volta ao pool', async () => {
      const boom = new Error('conexão perdida');
      conn.beginTransaction.mockRejectedValue(boom);
      const work = vi.fn(async () => 'ok');

      await expect(inTransaction(work)).rejects.toBe(boom);

      expect(work).not.toHaveBeenCalled();
      expect(conn.commit).not.toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('rollback que também falha não esconde o erro original nem prende a conexão', async () => {
      const boom = new Error('erro do trabalho');
      conn.rollback.mockRejectedValue(new Error('conexão caiu no rollback'));

      await expect(
        inTransaction(async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('sem conexão disponível, o erro sobe e não há o que devolver', async () => {
      const boom = new Error('pool esgotado');
      fakePool.getConnection.mockRejectedValue(boom);
      const work = vi.fn(async () => 'ok');

      await expect(inTransaction(work)).rejects.toBe(boom);

      expect(work).not.toHaveBeenCalled();
      expect(conn.beginTransaction).not.toHaveBeenCalled();
      expect(conn.release).not.toHaveBeenCalled();
    });
  });

  describe('pingDb', () => {
    it('faz um SELECT 1 numa conexão do pool e a devolve', async () => {
      await expect(pingDb()).resolves.toBeUndefined();

      expect(fakePool.getConnection).toHaveBeenCalledTimes(1);
      expect(conn.query).toHaveBeenCalledTimes(1);
      expect(conn.query).toHaveBeenCalledWith('SELECT 1');
      expect(conn.release).toHaveBeenCalledTimes(1);
      // Ping não é transação.
      expect(conn.beginTransaction).not.toHaveBeenCalled();
    });

    it('banco que não responde: o erro sobe (o /health vira 500) e a conexão é devolvida', async () => {
      const boom = new Error('PROTOCOL_CONNECTION_LOST');
      conn.query.mockRejectedValue(boom);

      await expect(pingDb()).rejects.toBe(boom);

      expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('banco inalcançável: o erro de conexão sobe', async () => {
      const boom = new Error('ECONNREFUSED');
      fakePool.getConnection.mockRejectedValue(boom);

      await expect(pingDb()).rejects.toBe(boom);

      expect(conn.query).not.toHaveBeenCalled();
      expect(conn.release).not.toHaveBeenCalled();
    });
  });
});
