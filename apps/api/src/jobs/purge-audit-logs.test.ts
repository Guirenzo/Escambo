import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/audit/audit.purge', () => ({ purgeAuditLogsOlderThan: vi.fn() }));

import { env } from '../config/env';
import { purgeAuditLogsOlderThan } from '../modules/audit/audit.purge';
import { runPurgeAuditLogs } from './purge-audit-logs';

const purge = vi.mocked(purgeAuditLogsOlderThan);
const original = env.AUDIT_LOG_PURGE_DAYS;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  env.AUDIT_LOG_PURGE_DAYS = original;
});

describe('job de expurgo do audit_logs (RNF-037)', () => {
  it('desligado por padrão: a auditoria fica e nada é apagado', async () => {
    expect(original).toBe(0);
    expect(await runPurgeAuditLogs()).toEqual({ skipped: 'disabled', days: null, removed: 0 });
    expect(purge).not.toHaveBeenCalled();
  });

  it('ligado, apaga o que passou do prazo configurado e diz quantas linhas saíram', async () => {
    env.AUDIT_LOG_PURGE_DAYS = 180;
    purge.mockResolvedValue(12);

    expect(await runPurgeAuditLogs()).toEqual({ skipped: null, days: 180, removed: 12 });
    expect(purge.mock.calls).toEqual([[180]]);
  });

  it('a recusa do expurgo (prazo curto ou trigger) vira falha do job, que o agendador registra', async () => {
    env.AUDIT_LOG_PURGE_DAYS = 90;
    const refused = new Error('recusado');
    purge.mockRejectedValue(refused);

    await expect(runPurgeAuditLogs()).rejects.toBe(refused);
  });
});
