import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/messaging/attachments.purge', () => ({
  purgeByRetention: vi.fn(),
  recordPurge: vi.fn(),
  lastPurge: vi.fn(),
  retentionDays: vi.fn(),
}));

import {
  lastPurge,
  purgeByRetention,
  recordPurge,
  retentionDays,
} from '../modules/messaging/attachments.purge';
import { runPurgeAttachments } from './purge-attachments';

const purge = vi.mocked(purgeByRetention);
const record = vi.mocked(recordPurge);
const last = vi.mocked(lastPurge);
const days = vi.mocked(retentionDays);

// ATTACHMENT_PURGE_HOUR padrão é 4 (Brasília = UTC-3): 02:00 BRT = 05:00Z; 12:00 BRT = 15:00Z.
const EARLY = new Date('2026-09-14T05:00:00Z');
const NOON = new Date('2026-09-14T15:00:00Z');
const summary = {
  retentionDays: 180,
  cutoff: '2026-03-18T15:00:00.000Z',
  purged: 3,
  orphansRemoved: 1,
  failed: 0,
};

describe('job purge-attachments (ADR 31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    days.mockResolvedValue(180);
    last.mockResolvedValue(null);
    purge.mockResolvedValue(summary);
  });

  it('antes da hora não faz nada (e diz por quê)', async () => {
    const r = await runPurgeAttachments({ now: EARLY });
    expect(r).toEqual({
      retentionDays: 180,
      cutoff: null,
      purged: 0,
      orphansRemoved: 0,
      failed: 0,
      skipped: 'before_hour',
    });
    expect(purge).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('já rodou hoje: pula; rodou ontem: roda de novo', async () => {
    last.mockResolvedValue({
      at: '2026-09-14T07:30:00.000Z', // 04:30 BRT de hoje
      purged: 0,
      orphansRemoved: 0,
      trigger: 'job',
    });
    expect((await runPurgeAttachments({ now: NOON })).skipped).toBe('already_today');
    expect(purge).not.toHaveBeenCalled();

    last.mockResolvedValue({
      at: '2026-09-13T07:30:00.000Z', // ontem
      purged: 0,
      orphansRemoved: 0,
      trigger: 'job',
    });
    const r = await runPurgeAttachments({ now: NOON });
    expect(r.skipped).toBeNull();
    expect(purge).toHaveBeenCalledWith(NOON);
  });

  it('depois da hora roda, guarda o registro do expurgo e devolve o resumo', async () => {
    const r = await runPurgeAttachments({ now: NOON });
    expect(r).toEqual({ ...summary, skipped: null });
    expect(record).toHaveBeenCalledWith({
      at: NOON.toISOString(),
      purged: 3,
      orphansRemoved: 1,
      trigger: 'job',
    });
  });

  it('force (botão do admin) ignora a hora e a trava diária e registra o gatilho', async () => {
    last.mockResolvedValue({
      at: '2026-09-14T07:30:00.000Z',
      purged: 0,
      orphansRemoved: 0,
      trigger: 'job',
    });
    const r = await runPurgeAttachments({ now: EARLY, force: true, trigger: 'admin' });
    expect(r.skipped).toBeNull();
    expect(purge).toHaveBeenCalledWith(EARLY);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'admin' }));
  });
});
