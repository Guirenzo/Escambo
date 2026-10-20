import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { MFA_LOCK_MINUTES, MFA_MAX_ATTEMPTS, mfaRepository } from './mfa.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const NOW = new Date('2026-10-20T12:00:00.000Z');
const CODES = [{ h: 'hash-1', usedAt: null }];

/**
 * Repository de `user_mfa` sem banco: o SQL de cada método, os parâmetros e o que ele faz com a
 * resposta. Que as condições do WHERE seguram a corrida (e o JSON_SET marca o código certo) é
 * conferido contra o MySQL na integração (dois-fatores.int.test.ts).
 */
describe('mfaRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('a trava é de 5 erros seguidos por 15 minutos', () => {
    expect(MFA_MAX_ATTEMPTS).toBe(5);
    expect(MFA_LOCK_MINUTES).toBe(15);
  });

  it('findByUser lê a linha totp com a trava calculada no instante de quem lê', async () => {
    const row = { id: 3, user_id: 7, locked: 0 };
    fakeDb.reply([row]);

    expect(await mfaRepository.findByUser(7, NOW)).toBe(row);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SELECT id, user_id, secret, is_enabled, confirmed_at, recovery_codes, last_used_step, failed_attempts, locked_until,',
    );
    expect(sql).toContain('(locked_until IS NOT NULL AND locked_until > :now) AS locked');
    expect(sql).toContain("WHERE user_id = :userId AND method = 'totp' LIMIT 1");
    expect(params).toEqual({ userId: 7, now: NOW });

    fakeDb.reply([]);
    expect(await mfaRepository.findByUser(8, NOW)).toBeUndefined();
  });

  it('isEnabled só conta a linha ativa', async () => {
    fakeDb.reply([{ enabled: 1 }], []);

    expect(await mfaRepository.isEnabled(7)).toBe(true);
    expect(await mfaRepository.isEnabled(8)).toBe(false);

    expect(fakeDb.calls[0]!.sql).toBe(
      "SELECT 1 AS enabled FROM user_mfa WHERE user_id = :userId AND method = 'totp' AND is_enabled = 1 LIMIT 1",
    );
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 8 });
  });

  it('savePending grava o segredo cifrado sem tocar numa linha já ativa nem na trava', async () => {
    await mfaRepository.savePending(7, 'enc:v1:abc');

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      "INSERT INTO user_mfa (user_id, method, secret, is_enabled) VALUES (:userId, 'totp', :secret, 0) ON DUPLICATE KEY UPDATE",
    );
    expect(sql).toContain('secret = IF(is_enabled = 0, :secret, secret)');
    expect(sql).toContain('last_used_step = IF(is_enabled = 0, NULL, last_used_step)');
    expect(sql).not.toContain('failed_attempts');
    expect(sql).not.toContain('locked_until');
    expect(params).toEqual({ userId: 7, secret: 'enc:v1:abc' });
  });

  it('enable liga a linha pendente com o passo, os códigos e a data; só se ainda é a mesma', async () => {
    const secret = Buffer.from('enc:v1:abc');
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    const data = { sealedSecret: secret, step: 99, recoveryCodes: CODES, now: NOW };
    expect(await mfaRepository.enable(3, data)).toBe(true);
    expect(await mfaRepository.enable(3, data)).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SET is_enabled = 1, confirmed_at = :now, last_used_step = :step, recovery_codes = :codes, failed_attempts = 0, locked_until = NULL',
    );
    expect(sql).toContain(
      'WHERE id = :id AND is_enabled = 0 AND secret = :secret AND (last_used_step IS NULL OR last_used_step < :step)',
    );
    expect(params).toEqual({
      id: 3,
      now: NOW,
      step: 99,
      codes: JSON.stringify(CODES),
      secret,
    });
  });

  it('acceptStep grava o passo só se for depois do último, e zera os erros', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await mfaRepository.acceptStep(3, 100)).toBe(true);
    expect(await mfaRepository.acceptStep(3, 100)).toBe(false);

    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE user_mfa SET last_used_step = :step, failed_attempts = 0, locked_until = NULL WHERE id = :id AND is_enabled = 1 AND (last_used_step IS NULL OR last_used_step < :step)',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 3, step: 100 });
  });

  it('useRecoveryCode marca a posição se o hash é o mesmo e ainda está livre', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await mfaRepository.useRecoveryCode(3, 4, 'hash-5', NOW)).toBe(true);
    expect(await mfaRepository.useRecoveryCode(3, 4, 'hash-5', NOW)).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('SET recovery_codes = JSON_SET(recovery_codes, :usedPath, :usedAt)');
    expect(sql).toContain('JSON_UNQUOTE(JSON_EXTRACT(recovery_codes, :hashPath)) = :hash');
    expect(sql).toContain("JSON_TYPE(JSON_EXTRACT(recovery_codes, :usedPath)) = 'NULL'");
    expect(params).toEqual({
      id: 3,
      hash: 'hash-5',
      usedPath: '$[4].usedAt',
      hashPath: '$[4].h',
      usedAt: '2026-10-20T12:00:00.000Z',
    });
  });

  it('registerFailure soma o erro, trava no quinto (15 min) e diz se travou', async () => {
    fakeDb.reply({ affectedRows: 1 }, [{ locked: 1 }], { affectedRows: 1 }, [{ locked: 0 }]);

    expect(await mfaRepository.registerFailure(3, NOW)).toBe(true);
    expect(await mfaRepository.registerFailure(3, NOW)).toBe(false);

    const [update, check] = fakeDb.calls;
    // locked_until vem antes de failed_attempts no SET: lê o contador antes de ele mudar.
    expect(update!.sql).toContain(
      'SET locked_until = IF(failed_attempts + 1 >= :max, :lockUntil, locked_until), failed_attempts = IF(failed_attempts + 1 >= :max, 0, failed_attempts + 1)',
    );
    expect(update!.params).toEqual({
      id: 3,
      max: 5,
      lockUntil: new Date('2026-10-20T12:15:00.000Z'),
    });
    expect(check!.sql).toContain('(locked_until IS NOT NULL AND locked_until > :now) AS locked');
    expect(check!.params).toEqual({ id: 3, now: NOW });

    // Linha que sumiu no meio (desativada): não está travada.
    fakeDb.reply({ affectedRows: 0 }, []);
    expect(await mfaRepository.registerFailure(3, NOW)).toBe(false);
  });

  it('replaceRecoveryCodes troca a lista só na linha ativa', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await mfaRepository.replaceRecoveryCodes(3, CODES)).toBe(true);
    expect(await mfaRepository.replaceRecoveryCodes(3, CODES)).toBe(false);

    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE user_mfa SET recovery_codes = :codes WHERE id = :id AND is_enabled = 1',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 3, codes: JSON.stringify(CODES) });
  });

  it('deleteForUser apaga a 2FA da conta e diz quantas linhas saíram', async () => {
    fakeDb.reply({ affectedRows: 1 });

    expect(await mfaRepository.deleteForUser(7)).toBe(1);

    expect(fakeDb.calls[0]!.sql).toBe('DELETE FROM user_mfa WHERE user_id = :userId');
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });
});
