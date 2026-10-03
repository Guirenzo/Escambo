import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { tokensRepository } from './tokens.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** Cada finalidade tem a própria tabela: um link de confirmação não serve para redefinir a senha. */
const TABLES = [
  ['verify_email', 'email_verification_tokens'],
  ['password_reset', 'password_reset_tokens'],
] as const;

/** Em que posição da sequência de chamadas o mock foi chamado (para conferir a ordem da transação). */
const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]!;

/**
 * Repository dos tokens de uso único (confirmação de e-mail e redefinição de senha) sem banco: a
 * tabela de cada finalidade, o filtro de validade e a transação do consumo. Se o SQL roda no MySQL
 * é assunto da integração.
 */
describe('tokensRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe.each(TABLES)('finalidade %s (tabela %s)', (purpose, table) => {
    const other = TABLES.find(([p]) => p !== purpose)![1];

    it('create guarda o hash do token com o dono e a validade', async () => {
      const expiresAt = new Date('2026-10-03T12:00:00Z');
      fakeDb.reply({ insertId: 1, affectedRows: 1 });

      expect(await tokensRepository.create(purpose, 7, 'hash-do-token', expiresAt)).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        `INSERT INTO ${table} (user_id, token, expires_at) VALUES (:userId, :tokenHash, :expiresAt)`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, tokenHash: 'hash-do-token', expiresAt });
    });

    it('invalidateOpen marca como usados só os tokens ainda abertos daquele usuário', async () => {
      fakeDb.reply({ affectedRows: 2 });

      expect(await tokensRepository.invalidateOpen(purpose, 7)).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        `UPDATE ${table} SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL`,
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('consume valida e marca como usado na MESMA transação, e devolve o dono do token', async () => {
      // O mysql2 pode devolver a coluna numérica como texto: o retorno é sempre número.
      fakeDb.reply([{ id: 31, user_id: '7' }], { affectedRows: 1 });

      expect(await tokensRepository.consume(purpose, 'hash-do-token')).toBe(7);

      expect(fakeDb.calls).toHaveLength(2);
      const [select, update] = fakeDb.calls;
      expect(select!.sql).toContain(`SELECT id, user_id FROM ${table}`);
      // Válido = existe, não foi usado e não venceu; a linha fica travada até o commit, para que
      // duas requisições simultâneas com o mesmo link não passem as duas.
      expect(select!.sql).toContain(
        'WHERE token = :tokenHash AND used_at IS NULL AND expires_at > NOW() LIMIT 1 FOR UPDATE',
      );
      expect(select!.params).toEqual({ tokenHash: 'hash-do-token' });
      expect(update!.sql).toBe(`UPDATE ${table} SET used_at = NOW() WHERE id = :id`);
      expect(update!.params).toEqual({ id: 31 });
      expect(fakeDb.sqls().join(' ')).not.toContain(other);

      // Uma conexão só, do início ao fim: begin, as duas instruções, commit, e a devolução ao pool.
      expect(fakeDb.pool.getConnection).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      expect(order(fakeDb.conn.beginTransaction)).toBeLessThan(order(fakeDb.conn.query));
      expect(fakeDb.conn.query.mock.invocationCallOrder[1]!).toBeLessThan(
        order(fakeDb.conn.commit),
      );
      expect(order(fakeDb.conn.commit)).toBeLessThan(order(fakeDb.conn.release));
    });
  });

  describe('consume: quando o link não vale ou o banco falha', () => {
    it('token inexistente, já usado ou vencido devolve null, sem marcar nada, e encerra a transação', async () => {
      fakeDb.reply([]);

      expect(await tokensRepository.consume('password_reset', 'hash-desconhecido')).toBeNull();

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.sql).toContain('SELECT id, user_id FROM password_reset_tokens');
      expect(fakeDb.calls[0]!.params).toEqual({ tokenHash: 'hash-desconhecido' });
      expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      // A conexão só volta ao pool depois de a transação estar encerrada.
      expect(order(fakeDb.conn.rollback)).toBeLessThan(order(fakeDb.conn.release));
    });

    it('se a busca falha, desfaz, devolve a conexão e repassa o erro', async () => {
      const boom = new Error('lock wait timeout');
      fakeDb.reply(boom);

      await expect(tokensRepository.consume('verify_email', 'hash-do-token')).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se marcar como usado falha, o token não é consumido: desfaz em vez de confirmar', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply([{ id: 31, user_id: 7 }], boom);

      await expect(tokensRepository.consume('verify_email', 'hash-do-token')).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      expect(order(fakeDb.conn.rollback)).toBeLessThan(order(fakeDb.conn.release));
    });

    it('se o commit falha, o token não é dado como consumido: o erro sobe e a conexão volta ao pool', async () => {
      const boom = new Error('commit failed');
      fakeDb.reply([{ id: 31, user_id: 7 }], { affectedRows: 1 });
      fakeDb.conn.commit.mockRejectedValueOnce(boom);

      await expect(tokensRepository.consume('password_reset', 'hash-do-token')).rejects.toBe(boom);

      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });

    it('se nem a transação abre, a conexão volta ao pool assim mesmo', async () => {
      const boom = new Error('server has gone away');
      fakeDb.conn.beginTransaction.mockRejectedValueOnce(boom);

      await expect(tokensRepository.consume('verify_email', 'hash-do-token')).rejects.toBe(boom);

      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
    });
  });
});
