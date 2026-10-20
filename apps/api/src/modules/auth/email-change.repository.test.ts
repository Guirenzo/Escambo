import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { emailChangeRepository, type EmailChangeAccount } from './email-change.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository da troca de e-mail (RF-017) sem banco: as travas e a ordem da transação, o teto
 * diário, o que a confirmação muda numa tacada só e o endereço que outra conta tem. Se o SQL roda
 * no MySQL é assunto da integração.
 */

const ACCOUNT: EmailChangeAccount = {
  id: 7,
  email: 'ana@escambo.test',
  role: 'client',
  status: 'active',
  deleted_at: null,
};

/** As instruções que gravam algo (UPDATE/INSERT); travas e leituras não contam. */
const writes = (): string[] => fakeDb.sqls().filter((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql));

beforeEach(() => fakeDb.reset());

describe('emailChangeRepository.create', () => {
  const data = {
    userId: 7,
    newEmail: 'nova@escambo.test',
    tokenHash: 'h'.repeat(64),
    expiresAt: new Date('2026-10-20T12:00:00Z'),
    maxPerDay: 5,
  };

  it('trava a conta, confere o teto, substitui os pedidos abertos e grava o novo, na mesma transação', async () => {
    fakeDb.reply([{ id: 7 }], [{ n: 4 }], { affectedRows: 1 }, { insertId: 31 });

    expect(await emailChangeRepository.create(data)).toBe(31);

    const [lock, count, replace, insert] = fakeDb.calls;
    expect(lock!.sql).toBe('SELECT id FROM users WHERE id = :userId FOR UPDATE');
    expect(lock!.params).toEqual({ userId: 7 });
    expect(count!.sql).toContain('COUNT(*) AS n FROM email_change_requests');
    expect(count!.sql).toContain('created_at > NOW() - INTERVAL 1 DAY');
    expect(replace!.sql).toBe(
      'UPDATE email_change_requests SET used_at = NOW(), outcome = :outcome WHERE user_id = :userId AND used_at IS NULL',
    );
    expect(replace!.params).toEqual({ userId: 7, outcome: 'replaced' });
    expect(insert!.sql).toBe(
      'INSERT INTO email_change_requests (user_id, new_email, token, expires_at) VALUES (:userId, :newEmail, :tokenHash, :expiresAt)',
    );
    expect(insert!.params).toEqual({
      userId: 7,
      newEmail: 'nova@escambo.test',
      tokenHash: 'h'.repeat(64),
      expiresAt: data.expiresAt,
    });
    expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
  });

  it('no teto (o mysql2 pode devolver a contagem como texto) não grava nada e devolve null', async () => {
    fakeDb.reply([{ id: 7 }], [{ n: '5' }]);

    expect(await emailChangeRepository.create(data)).toBeNull();

    expect(fakeDb.calls).toHaveLength(2);
    expect(fakeDb.sqls().join(' ')).not.toContain('INSERT');
  });

  it('contagem ausente vale como zero', async () => {
    fakeDb.reply([{ id: 7 }], [], { affectedRows: 0 }, { insertId: 9 });
    expect(await emailChangeRepository.create(data)).toBe(9);
  });
});

describe('emailChangeRepository.findPending e cancelOpen', () => {
  it('findPending: o mais novo ainda aberto e não vencido', async () => {
    const row = { id: 3, new_email: 'nova@escambo.test', expires_at: new Date() };
    fakeDb.reply([row]);
    expect(await emailChangeRepository.findPending(7)).toEqual(row);
    expect(fakeDb.calls[0]!.sql).toContain(
      'WHERE user_id = :userId AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    );
    expect(fakeDb.calls[0]!.sql).not.toContain('token');

    fakeDb.reply([]);
    expect(await emailChangeRepository.findPending(7)).toBeUndefined();
  });

  it('cancelOpen fecha os abertos como cancelados e diz quantos eram', async () => {
    fakeDb.reply({ affectedRows: 2 });
    expect(await emailChangeRepository.cancelOpen(7)).toBe(2);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, outcome: 'cancelled' });
  });
});

describe('emailChangeRepository.confirm', () => {
  const check = vi.fn();
  beforeEach(() => check.mockReset());

  it('token que não vale (inexistente, usado ou vencido): invalid, sem abrir transação', async () => {
    fakeDb.reply([]);
    expect(await emailChangeRepository.confirm('hash', check)).toEqual({ kind: 'invalid' });
    expect(fakeDb.calls[0]!.sql).toContain(
      'WHERE token = :tokenHash AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
    );
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('trava a conta antes do pedido, troca o e-mail, gasta o token, invalida os links antigos e derruba as sessões', async () => {
    fakeDb.reply(
      [{ user_id: '7' }],
      [ACCOUNT],
      [{ id: 31, new_email: 'nova@escambo.test' }],
      [],
      { affectedRows: 1 },
      { affectedRows: 1 },
      { affectedRows: 0 },
      { affectedRows: 1 },
      { affectedRows: 2 },
      { affectedRows: 3 },
    );

    expect(await emailChangeRepository.confirm('hash', check)).toEqual({
      kind: 'confirmed',
      requestId: 31,
      userId: 7,
      oldEmail: 'ana@escambo.test',
      newEmail: 'nova@escambo.test',
      sessionsRevoked: 3,
    });

    expect(check).toHaveBeenCalledWith(ACCOUNT, 'nova@escambo.test');
    const sqls = fakeDb.sqls();
    expect(sqls[1]).toContain('FROM users WHERE id = :userId FOR UPDATE');
    expect(sqls[2]).toContain('FROM email_change_requests');
    expect(sqls[2]).toContain('LIMIT 1 FOR UPDATE');
    expect(fakeDb.calls[2]!.params).toEqual({ tokenHash: 'hash', userId: 7 });
    expect(sqls[3]).toBe('SELECT id FROM users WHERE email = :newEmail AND id <> :userId LIMIT 1');
    expect(sqls[4]).toContain('SET email = :newEmail, email_verified_at = NOW()');
    expect(sqls[4]).toContain("WHEN status = 'pending_verification' THEN 'active'");
    expect(sqls[5]).toBe(
      "UPDATE email_change_requests SET used_at = NOW(), outcome = 'confirmed' WHERE id = :id",
    );
    expect(fakeDb.calls[6]!.params).toEqual({ userId: 7, outcome: 'replaced' });
    expect(sqls[7]).toContain('UPDATE email_verification_tokens SET used_at = NOW()');
    expect(sqls[8]).toContain('UPDATE password_reset_tokens SET used_at = NOW()');
    expect(sqls[9]).toBe(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL',
    );
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  });

  it('o pedido sumiu entre a leitura e a trava (outra aba confirmou ou cancelou): invalid, nada muda', async () => {
    fakeDb.reply([{ user_id: 7 }], [ACCOUNT], []);
    expect(await emailChangeRepository.confirm('hash', check)).toEqual({ kind: 'invalid' });
    expect(check).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('a regra do serviço recusa: o erro sobe e a transação é desfeita', async () => {
    fakeDb.reply([{ user_id: 7 }], [ACCOUNT], [{ id: 31, new_email: 'nova@escambo.test' }]);
    const refused = new Error('recusado');
    const refuse = (): never => {
      throw refused;
    };
    await expect(emailChangeRepository.confirm('hash', refuse)).rejects.toBe(refused);
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
  });

  it('endereço de outra conta, conferido ou pego pelo índice único: taken, sem trocar nada', async () => {
    fakeDb.reply(
      [{ user_id: 7 }],
      [ACCOUNT],
      [{ id: 31, new_email: 'nova@escambo.test' }],
      [{ id: 9 }],
    );
    expect(await emailChangeRepository.confirm('hash', check)).toEqual({ kind: 'taken' });
    expect(writes()).toEqual([]);

    fakeDb.reset();
    const dup = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    fakeDb.reply(
      [{ user_id: 7 }],
      [ACCOUNT],
      [{ id: 31, new_email: 'nova@escambo.test' }],
      [],
      dup,
    );
    expect(await emailChangeRepository.confirm('hash', check)).toEqual({ kind: 'taken' });
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  });

  it('outra falha do banco sobe como veio', async () => {
    const boom = Object.assign(new Error('lock wait'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    fakeDb.reply([{ user_id: 7 }], boom);
    await expect(emailChangeRepository.confirm('hash', check)).rejects.toBe(boom);
  });
});
