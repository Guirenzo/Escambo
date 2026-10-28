import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { USER_COLUMNS } from './auth.repository';
import { googleRepository } from './google.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * O repository do login com Google (RF-002) sem banco: o que cada método pede e o que faz com a
 * resposta. Que o SQL roda (e que as chaves únicas recusam) é assunto do google.int.test.ts.
 */
describe('googleRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('acha a conta pelo sub ou pelo e-mail, com as colunas do login e o vínculo', async () => {
    const row = { id: 7, google_sub: '1098' };
    fakeDb.reply([row], []);
    expect(await googleRepository.findBySub('1098')).toBe(row);
    expect(await googleRepository.findByEmail('ana@gmail.com')).toBeUndefined();
    expect(fakeDb.calls.map((c) => c.sql)).toEqual([
      `SELECT ${USER_COLUMNS}, google_sub FROM users WHERE google_sub = :sub LIMIT 1`,
      `SELECT ${USER_COLUMNS}, google_sub FROM users WHERE email = :email LIMIT 1`,
    ]);
    expect(fakeDb.calls.map((c) => c.params)).toEqual([
      { sub: '1098' },
      { email: 'ana@gmail.com' },
    ]);
  });

  it('vincula só a conta confirmada e ainda sem vínculo; diz se vinculou', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });
    expect(await googleRepository.linkConfirmed(7, '1098')).toBe(true);
    expect(await googleRepository.linkConfirmed(7, '1098')).toBe(false);
    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE users SET google_sub = :sub WHERE id = :userId AND google_sub IS NULL AND email_verified_at IS NOT NULL',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, sub: '1098' });
  });

  it('retoma a conta não confirmada num UPDATE só: confirma, apaga a senha e vincula', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });
    expect(await googleRepository.claimUnverified(7, '1098')).toBe(true);
    expect(await googleRepository.claimUnverified(7, '1098')).toBe(false);
    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('SET google_sub = :sub, password_hash = NULL, email_verified_at = NOW()');
    expect(sql).toContain("status = CASE WHEN status = 'pending_verification' THEN 'active'");
    expect(sql).toMatch(/WHERE id = :userId AND google_sub IS NULL AND email_verified_at IS NULL$/);
    expect(params).toEqual({ userId: 7, sub: '1098' });
  });

  it('a conta nova nasce ativa, confirmada, vinculada e sem senha', async () => {
    fakeDb.reply({ insertId: 42 });
    const data = {
      ulid: '01U',
      email: 'ana@gmail.com',
      role: 'client',
      sub: '1098',
      timezone: null,
    };
    expect(await googleRepository.createUser(data)).toBe(42);
    expect(fakeDb.calls[0]!.sql).toContain(
      "VALUES (:ulid, :email, NULL, :role, 'active', :timezone, NOW(), :sub)",
    );
    expect(fakeDb.calls[0]!.params).toEqual(data);
  });

  it('o passe novo apaga os vencidos antes e vence pelo relógio do banco', async () => {
    await googleRepository.createTicket({
      hash: 'h1',
      purpose: 'signup',
      ttlSeconds: 900,
      sub: '1098',
      email: 'ana@gmail.com',
      name: 'Ana',
    });
    await googleRepository.createTicket({
      hash: 'h2',
      purpose: 'exchange',
      ttlSeconds: 120,
      userId: 7,
    });
    expect(fakeDb.calls[0]!.sql).toBe(
      'DELETE FROM google_login_tickets WHERE expires_at <= NOW() LIMIT 500',
    );
    expect(fakeDb.calls[1]!.sql).toContain('NOW() + INTERVAL :ttlSeconds SECOND');
    expect(fakeDb.calls[1]!.params).toEqual({
      hash: 'h1',
      purpose: 'signup',
      ttlSeconds: 900,
      userId: null,
      sub: '1098',
      email: 'ana@gmail.com',
      name: 'Ana',
    });
    expect(fakeDb.calls[3]!.params).toEqual({
      hash: 'h2',
      purpose: 'exchange',
      ttlSeconds: 120,
      userId: 7,
      sub: null,
      email: null,
      name: null,
    });
  });

  it('o state que já voltou é recusado pela chave única; outro erro sobe', async () => {
    expect(await googleRepository.rememberState('s1', 600)).toBe(true);
    expect(fakeDb.calls[1]!.params).toMatchObject({
      hash: 's1',
      purpose: 'state',
      ttlSeconds: 600,
    });

    fakeDb.reply({}, Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));
    expect(await googleRepository.rememberState('s1', 600)).toBe(false);

    fakeDb.reply({}, new Error('banco fora'));
    await expect(googleRepository.rememberState('s2', 600)).rejects.toThrow('banco fora');
  });

  it('usar o passe: confere tipo e validade, apaga na mesma transação e devolve o que ele leva', async () => {
    const row = { id: 3, user_id: 7, google_sub: null, email: null, name: null };
    fakeDb.reply([row], { affectedRows: 1 });
    expect(await googleRepository.consumeTicket('exchange', 'h1')).toBe(row);
    expect(fakeDb.calls[0]!.sql).toContain(
      'WHERE ticket_hash = :hash AND purpose = :purpose AND expires_at > NOW() LIMIT 1 FOR UPDATE',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ hash: 'h1', purpose: 'exchange' });
    expect(fakeDb.calls[1]!.sql).toBe('DELETE FROM google_login_tickets WHERE id = :id');
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
  });

  it('passe que não vale: null, sem apagar nada; erro no meio desfaz e devolve a conexão', async () => {
    expect(await googleRepository.consumeTicket('signup', 'h9')).toBeNull();
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);

    fakeDb.reply([{ id: 3 }], new Error('banco fora'));
    await expect(googleRepository.consumeTicket('signup', 'h9')).rejects.toThrow('banco fora');
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(2);
    expect(fakeDb.conn.release).toHaveBeenCalledTimes(2);
  });
});
