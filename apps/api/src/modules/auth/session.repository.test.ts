import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { sessionRepository } from './session.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository de `user_sessions` (refresh tokens) sem banco: o que cada método pede e o que faz com
 * a resposta. Se o SQL roda no MySQL é assunto da integração.
 */
describe('sessionRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('create grava a sessão com o hash do token, a validade e o IP e navegador de quem entrou', async () => {
    const data = {
      userId: 7,
      tokenHash: 'hash-sha256',
      expiresAt: new Date('2026-10-09T12:00:00Z'),
      ip: '203.0.113.9',
      userAgent: 'vitest',
    };
    fakeDb.reply({ insertId: 1, affectedRows: 1 });

    expect(await sessionRepository.create(data)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      'INSERT INTO user_sessions (user_id, refresh_token, ip_address, user_agent, expires_at) ' +
        'VALUES (:userId, :tokenHash, :ip, :userAgent, :expiresAt)',
    );
    expect(params).toEqual(data);
  });

  it('create aceita sessão sem IP nem navegador conhecidos: os dois vão como NULL', async () => {
    const data = {
      userId: 7,
      tokenHash: 'hash-sha256',
      expiresAt: new Date('2026-10-09T12:00:00Z'),
      ip: null,
      userAgent: null,
    };
    fakeDb.reply({ insertId: 2, affectedRows: 1 });

    await sessionRepository.create(data);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.params).toStrictEqual(data);
  });

  describe('findValidByHash', () => {
    it('só vale sessão com aquele hash, não revogada e não vencida; devolve a primeira linha', async () => {
      const row = { id: 10, user_id: 7, refresh_token: 'hash-sha256', revoked_at: null };
      fakeDb.reply([row]);

      expect(await sessionRepository.findValidByHash('hash-sha256')).toBe(row);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT id, user_id, refresh_token, expires_at, revoked_at');
      expect(sql).toContain(
        'FROM user_sessions WHERE refresh_token = :tokenHash AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1',
      );
      expect(params).toEqual({ tokenHash: 'hash-sha256' });
    });

    it('sem sessão válida devolve undefined', async () => {
      fakeDb.reply([]);
      expect(await sessionRepository.findValidByHash('hash-de-outro')).toBeUndefined();
    });
  });

  it('revokeByHash revoga só a sessão daquele token, e só se ainda estiver aberta (não regrava a data)', async () => {
    fakeDb.reply({ affectedRows: 1 });

    expect(await sessionRepository.revokeByHash('hash-sha256')).toBeUndefined();

    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE refresh_token = :tokenHash AND revoked_at IS NULL',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ tokenHash: 'hash-sha256' });
  });

  describe('revokeAllForUser (RN-008)', () => {
    it('revoga as sessões abertas daquele usuário e devolve quantas foram', async () => {
      fakeDb.reply({ affectedRows: 3 });

      expect(await sessionRepository.revokeAllForUser(7)).toBe(3);

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });

    it('sem sessão aberta devolve 0', async () => {
      fakeDb.reply({ affectedRows: 0 });
      expect(await sessionRepository.revokeAllForUser(7)).toBe(0);
    });
  });

  it('falha do banco sobe para quem chamou (nenhum método engole o erro)', async () => {
    const boom = new Error('connection lost');
    fakeDb.reply(boom, boom, boom, boom);
    await expect(sessionRepository.findValidByHash('hash')).rejects.toBe(boom);
    await expect(sessionRepository.revokeAllForUser(7)).rejects.toBe(boom);
    // Sessão que não gravou ou não revogou não pode parecer que deu certo (login e logout).
    await expect(
      sessionRepository.create({
        userId: 7,
        tokenHash: 'hash',
        expiresAt: new Date('2026-10-09T12:00:00Z'),
        ip: null,
        userAgent: null,
      }),
    ).rejects.toBe(boom);
    await expect(sessionRepository.revokeByHash('hash')).rejects.toBe(boom);
    expect(fakeDb.calls).toHaveLength(4);
  });
});
