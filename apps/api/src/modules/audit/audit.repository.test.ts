import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { auditRepository } from './audit.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository da trilha de auditoria (RN-010) sem banco: o que é gravado e em que coluna. A trilha
 * só cresce: o repository não tem como alterar nem apagar um registro.
 */
describe('auditRepository', () => {
  beforeEach(() => fakeDb.reset());

  const entry = {
    userId: 7,
    action: 'lgpd_consent',
    entityType: 'consent',
    entityId: 42,
    oldValue: null,
    newValue: '{"accepted":true}',
    ip: '10.0.0.1',
    userAgent: 'vitest',
  };

  it('grava uma linha em audit_logs com quem fez, o quê, sobre o quê, antes e depois, IP e navegador', async () => {
    fakeDb.reply({ insertId: 1, affectedRows: 1 });

    expect(await auditRepository.record(entry)).toBeUndefined();

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent) VALUES (:userId, :action, :entityType, :entityId, :oldValue, :newValue, :ip, :userAgent)',
    );
    expect(fakeDb.calls[0]!.params).toEqual(entry);
  });

  it('navegador acima de 512 caracteres é gravado cortado no tamanho da coluna (com o sql_mode estrito, inteiro derrubaria a linha)', async () => {
    fakeDb.reply({ insertId: 2, affectedRows: 1 });

    await auditRepository.record({ ...entry, userAgent: 'M'.repeat(600) });

    expect(fakeDb.calls[0]!.params).toEqual({ ...entry, userAgent: 'M'.repeat(512) });
  });

  it('ação do sistema (sem usuário, sem entidade, sem origem) é gravada com null em cada coluna', async () => {
    const system = {
      userId: null,
      action: 'job.expire_exports',
      entityType: null,
      entityId: null,
      oldValue: null,
      newValue: null,
      ip: null,
      userAgent: null,
    };

    await auditRepository.record(system);

    expect(fakeDb.calls[0]!.sql).toContain('INSERT INTO audit_logs');
    expect(fakeDb.calls[0]!.params).toEqual(system);
  });

  it('a falha do banco é repassada (quem decide engolir é o service, que é best-effort)', async () => {
    const boom = new Error('ER_DATA_TOO_LONG');
    fakeDb.reply(boom);
    await expect(auditRepository.record(entry)).rejects.toBe(boom);
  });

  it('a trilha só recebe registros novos: não existe método para alterar ou apagar', () => {
    expect(Object.keys(auditRepository)).toEqual(['record']);
  });
});
