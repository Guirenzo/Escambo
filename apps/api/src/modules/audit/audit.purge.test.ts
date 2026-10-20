import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { purgeAuditLogsOlderThan } from './audit.purge';
import {
  AUDIT_LOG_MIN_RETENTION_DAYS,
  AUDIT_LOG_PURGE_BATCH,
  AUDIT_LOG_PURGE_MAX_BATCHES,
} from './audit.retention';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Expurgo do audit_logs (RNF-037) sem banco: o prazo mínimo, a instrução e os lotes. Que o MySQL
 * recusa a linha com menos de 90 dias é assunto da integração (ledger-imutavel.int.test).
 */
const DELETE_SQL =
  'DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL :days DAY) ORDER BY id LIMIT :limit';

describe('expurgo do audit_logs (RNF-037)', () => {
  beforeEach(() => fakeDb.reset());

  it.each([0, 30, 89, 89.5, Number.NaN])(
    '%s dias é recusado antes do banco: nenhuma instrução sai',
    async (days) => {
      await expect(purgeAuditLogsOlderThan(days)).rejects.toThrow(
        'menos que a retenção mínima de 90 (RNF-037)',
      );
      expect(fakeDb.calls).toEqual([]);
    },
  );

  it('apaga as mais antigas que o prazo, em lotes, até um lote vir incompleto', async () => {
    fakeDb.reply({ affectedRows: AUDIT_LOG_PURGE_BATCH });
    fakeDb.reply({ affectedRows: 7 });

    expect(await purgeAuditLogsOlderThan(180)).toBe(AUDIT_LOG_PURGE_BATCH + 7);

    expect(fakeDb.calls).toEqual([
      { sql: DELETE_SQL, params: { days: 180, limit: AUDIT_LOG_PURGE_BATCH } },
      { sql: DELETE_SQL, params: { days: 180, limit: AUDIT_LOG_PURGE_BATCH } },
    ]);
  });

  it('exatamente a retenção mínima é aceita; nada vencido, um DELETE só', async () => {
    fakeDb.reply({ affectedRows: 0 });

    expect(await purgeAuditLogsOlderThan(AUDIT_LOG_MIN_RETENTION_DAYS)).toBe(0);

    expect(fakeDb.calls).toEqual([
      { sql: DELETE_SQL, params: { days: 90, limit: AUDIT_LOG_PURGE_BATCH } },
    ]);
  });

  it('para no teto de lotes por rodada; o resto sai na rodada seguinte', async () => {
    for (let i = 0; i <= AUDIT_LOG_PURGE_MAX_BATCHES; i++)
      fakeDb.reply({ affectedRows: AUDIT_LOG_PURGE_BATCH });

    expect(await purgeAuditLogsOlderThan(365)).toBe(
      AUDIT_LOG_PURGE_BATCH * AUDIT_LOG_PURGE_MAX_BATCHES,
    );
    expect(fakeDb.calls).toHaveLength(AUDIT_LOG_PURGE_MAX_BATCHES);
  });

  it('a recusa do banco (trigger da 0046) é repassada a quem chamou', async () => {
    const refused = Object.assign(
      new Error('audit_logs guarda cada registro por no mínimo 90 dias'),
      {
        errno: 1644,
        sqlState: '45000',
      },
    );
    fakeDb.reply(refused);

    await expect(purgeAuditLogsOlderThan(90)).rejects.toBe(refused);
  });
});
