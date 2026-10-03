import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { remindersRepository } from './reminders.repository';
import { candidatesSql, claimSql } from './reminders-sql';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** Como o fakeDb guarda as instruções: espaços e quebras de linha reduzidos a um espaço. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const dbError = (code: string): Error => Object.assign(new Error(code), { code });

/** qui, 01/10/2026 às 12:00 em Brasília. */
const NOW = new Date('2026-10-01T15:00:00.000Z');
const AFTER = { due: new Date('2026-10-02T12:00:00.000Z'), id: 41 };

/**
 * A conexão da transação do lembrete: responde pelo fakeDb (que guarda a instrução), mas é um espião
 * à parte, para conferir que a trava roda NELA e não no pool.
 */
function txConn(): { conn: PoolConnection; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn((sql: string, params?: unknown) => fakeDb.conn.query(sql, params));
  return { conn: { query } as unknown as PoolConnection, query };
}

/**
 * O livro dos lembretes sem banco: a janela calculada do agora, a trava compartilhada da
 * contratação e a trava do lembrete (ganhou, perdeu para o estado ou para outra instância).
 */
describe('livro dos lembretes (ADR 58)', () => {
  beforeEach(() => fakeDb.reset());

  describe('candidatas', () => {
    it('sem fuso em que seja dia, não consulta o banco', async () => {
      const rows = await remindersRepository.candidates('delivery', {
        now: NOW,
        zones: [],
        after: AFTER,
      });

      expect(rows).toEqual([]);
      expect(fakeDb.calls).toHaveLength(0);
    });

    it('a janela vem do agora: vencimento entre +2 h e +48 h, aviso de 12 h atrás, revisão de 7 dias atrás', async () => {
      const page = [{ contract_id: 7, entity_id: 7 }];
      fakeDb.reply(page);

      const rows = await remindersRepository.candidates('delivery', {
        now: NOW,
        zones: ['America/Sao_Paulo', 'America/Manaus'],
        after: AFTER,
      });

      expect(rows).toEqual(page);
      expect(fakeDb.calls).toEqual([
        {
          sql: flat(candidatesSql('delivery')),
          params: {
            zones: ['America/Sao_Paulo', 'America/Manaus'],
            minDue: new Date('2026-10-01T17:00:00.000Z'),
            maxDue: new Date('2026-10-03T15:00:00.000Z'),
            aged: new Date('2026-10-01T03:00:00.000Z'),
            staleBefore: new Date('2026-09-24T15:00:00.000Z'),
            afterDue: AFTER.due,
            afterId: 41,
          },
        },
      ]);
    });

    it('consulta o SQL do tipo pedido, com o cursor recebido', async () => {
      const after = { due: new Date('2026-09-20T10:00:00.000Z'), id: 300 };

      await remindersRepository.candidates('milestone_revision', {
        now: NOW,
        zones: ['America/Noronha'],
        after,
      });

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toBe(flat(candidatesSql('milestone_revision')));
      expect(fakeDb.calls[0]!.params).toMatchObject({
        zones: ['America/Noronha'],
        afterDue: after.due,
        afterId: 300,
      });
    });
  });

  describe('trava da contratação', () => {
    it('é compartilhada (FOR SHARE), na conexão da transação, e diz que a contratação existe', async () => {
      const { conn, query } = txConn();
      fakeDb.reply([{ id: 7 }]);

      expect(await remindersRepository.lockContract(conn, 7)).toBe(true);

      expect(query).toHaveBeenCalledTimes(1);
      expect(fakeDb.calls).toEqual([
        {
          sql: 'SELECT id FROM contracts WHERE id = :contractId FOR SHARE',
          params: { contractId: 7 },
        },
      ]);
    });

    it('contratação que não existe mais: false', async () => {
      const { conn } = txConn();
      fakeDb.reply([]);

      expect(await remindersRepository.lockContract(conn, 7)).toBe(false);
    });
  });

  describe('trava do lembrete', () => {
    const due = new Date('2026-10-03T15:00:00.000Z');
    const start = new Date('2026-09-30T13:00:00.000Z');
    const params = { contractId: 7, entityId: 31, due, seq: 0, start, now: NOW };

    it('ganha quando grava a linha, na conexão da transação, com o SQL do tipo e o início que a candidata trouxe', async () => {
      const { conn, query } = txConn();
      fakeDb.reply({ affectedRows: 1 });

      expect(await remindersRepository.claim(conn, 'milestone_approval', params)).toBe(true);

      expect(query).toHaveBeenCalledTimes(1);
      expect(fakeDb.calls).toEqual([
        {
          sql: flat(claimSql('milestone_approval')),
          params: { contractId: 7, entityId: 31, due, seq: 0, start, now: NOW },
        },
      ]);
    });

    it('sem início (revisão parada), passa start null: a trava compara NULL <=> NULL', async () => {
      const { conn } = txConn();
      fakeDb.reply({ affectedRows: 1 });

      expect(
        await remindersRepository.claim(conn, 'revision', { ...params, entityId: 7, start: null }),
      ).toBe(true);

      expect(fakeDb.calls).toEqual([
        {
          sql: flat(claimSql('revision')),
          params: { contractId: 7, entityId: 7, due, seq: 0, start: null, now: NOW },
        },
      ]);
    });

    it('perde quando o estado ou o início mudou e o INSERT … SELECT não grava nada', async () => {
      const { conn } = txConn();
      fakeDb.reply({ affectedRows: 0 });

      expect(await remindersRepository.claim(conn, 'delivery', { ...params, entityId: 7 })).toBe(
        false,
      );
      expect(fakeDb.calls[0]!.sql).toBe(flat(claimSql('delivery')));
      expect(fakeDb.calls[0]!.params).toMatchObject({ start });
    });

    it('perde quando outra instância gravou antes (ER_DUP_ENTRY), sem lançar', async () => {
      const { conn } = txConn();
      fakeDb.reply(dbError('ER_DUP_ENTRY'));

      expect(await remindersRepository.claim(conn, 'extension', { ...params, seq: 2 })).toBe(false);
    });

    it('qualquer outro erro sobe para quem chamou (a transação desfaz)', async () => {
      const { conn } = txConn();
      const boom = dbError('ER_LOCK_DEADLOCK');
      fakeDb.reply(boom);

      await expect(remindersRepository.claim(conn, 'approval', params)).rejects.toBe(boom);
    });
  });
});
