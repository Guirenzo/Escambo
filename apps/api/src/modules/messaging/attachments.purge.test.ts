import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../media/media.storage', () => ({
  removeMediaOrphans: vi.fn().mockResolvedValue(0),
  mediaUsage: vi.fn().mockResolvedValue({ files: 0, variants: 0, bytes: 0, orphans: 0 }),
}));

vi.mock('node:fs/promises', () => ({ unlink: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./messaging.repository', () => ({
  messagingRepository: {
    listPurgeable: vi.fn(),
    listUserAttachments: vi.fn(),
    markPurged: vi.fn(),
    listAttachmentKeys: vi.fn(),
    attachmentStats: vi.fn(),
  },
}));
vi.mock('./attachments.storage', () => ({
  removeAttachment: vi.fn(),
  listUploadedFiles: vi.fn(),
  dataDirUsage: vi.fn(),
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { get: vi.fn(), getNumber: vi.fn(), set: vi.fn() },
}));

import { unlink } from 'node:fs/promises';
import { settingsRepository } from '../settings/settings.repository';
import {
  LAST_PURGE_KEY,
  lastPurge,
  purgeByRetention,
  purgeForUser,
  recordPurge,
  removeOrphans,
  storageReport,
} from './attachments.purge';
import { dataDirUsage, listUploadedFiles, removeAttachment } from './attachments.storage';
import { messagingRepository } from './messaging.repository';

const repo = vi.mocked(messagingRepository);
const disk = {
  removeAttachment: vi.mocked(removeAttachment),
  list: vi.mocked(listUploadedFiles),
  usage: vi.mocked(dataDirUsage),
};
const settings = vi.mocked(settingsRepository);
const rm = vi.mocked(unlink);

const NOW = new Date('2026-09-14T15:00:00Z');
const DAY = 86_400_000;
const file = (key: string, ageMs: number) => ({
  key,
  path: `/data/uploads/${key}`,
  size: 10,
  mtimeMs: NOW.getTime() - ageMs,
});

beforeEach(() => {
  vi.clearAllMocks();
  settings.getNumber.mockResolvedValue(180);
  repo.listPurgeable.mockResolvedValue([]);
  repo.listAttachmentKeys.mockResolvedValue([]);
  disk.list.mockResolvedValue([]);
  disk.removeAttachment.mockResolvedValue(undefined);
  repo.markPurged.mockResolvedValue(undefined);
});

describe('purgeByRetention', () => {
  it('corte = hoje − retenção; apaga o arquivo, marca a linha e isola falhas', async () => {
    repo.listPurgeable.mockResolvedValue([
      { id: 1, file_url: '2026/03/a.png' },
      { id: 2, file_url: '2026/03/b.pdf' },
    ]);
    disk.removeAttachment.mockImplementation(async (key) => {
      if (key.endsWith('b.pdf')) throw new Error('EACCES');
    });

    const r = await purgeByRetention(NOW);

    expect(settings.getNumber).toHaveBeenCalledWith('attachment_retention_days', 180);
    expect(repo.listPurgeable).toHaveBeenCalledWith(new Date(NOW.getTime() - 180 * DAY), 500);
    expect(repo.markPurged).toHaveBeenCalledTimes(1);
    expect(repo.markPurged).toHaveBeenCalledWith(1, 'retention');
    expect(r).toEqual({
      retentionDays: 180,
      cutoff: new Date(NOW.getTime() - 180 * DAY).toISOString(),
      purged: 1,
      orphansRemoved: 0,
      failed: 1,
    });
  });
});

describe('removeOrphans', () => {
  it('só apaga arquivo sem linha E com mais de 24 h', async () => {
    repo.listAttachmentKeys.mockResolvedValue(['2026/09/known.png']);
    disk.list.mockResolvedValue([
      file('2026/09/known.png', 30 * DAY), // tem linha
      file('2026/09/old-orphan.png', 3 * DAY), // órfão velho → sai
      file('2026/09/fresh-orphan.png', 60_000), // upload em andamento → fica
    ]);

    expect(await removeOrphans(NOW)).toBe(1);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith('/data/uploads/2026/09/old-orphan.png');
  });

  it('pasta vazia: nem consulta o banco', async () => {
    expect(await removeOrphans(NOW)).toBe(0);
    expect(repo.listAttachmentKeys).not.toHaveBeenCalled();
  });
});

describe('purgeForUser (LGPD)', () => {
  it('apaga tudo que o titular enviou e marca com o motivo lgpd', async () => {
    repo.listUserAttachments.mockResolvedValue([
      { id: 7, file_url: 'k1' },
      { id: 8, file_url: 'k2' },
    ]);
    expect(await purgeForUser(42)).toBe(2);
    expect(repo.listUserAttachments).toHaveBeenCalledWith(42);
    expect(disk.removeAttachment).toHaveBeenCalledWith('k1');
    expect(repo.markPurged).toHaveBeenCalledWith(8, 'lgpd');
  });
});

describe('registro do último expurgo', () => {
  it('grava JSON em platform_settings e lê de volta; JSON inválido vira null', async () => {
    await recordPurge({ at: NOW.toISOString(), purged: 2, orphansRemoved: 0, trigger: 'admin' });
    expect(settings.set).toHaveBeenCalledWith(LAST_PURGE_KEY, expect.any(String), 'json');
    settings.get.mockResolvedValue(
      JSON.stringify({ at: NOW.toISOString(), purged: 2, orphansRemoved: 0, trigger: 'admin' }),
    );
    expect(await lastPurge()).toMatchObject({ purged: 2, trigger: 'admin' });
    settings.get.mockResolvedValue('{nope');
    expect(await lastPurge()).toBeNull();
    settings.get.mockResolvedValue(null);
    expect(await lastPurge()).toBeNull();
  });
});

describe('storageReport', () => {
  it('cruza banco e disco: sem arquivo (missing) e sem linha (orphans)', async () => {
    disk.usage.mockImplementation(async (sub) =>
      sub === 'uploads' ? { files: 3, bytes: 3000 } : { files: 1, bytes: 40 },
    );
    repo.attachmentStats.mockResolvedValue({
      active: 2,
      activeBytes: 2000,
      purged: 5,
      purged30d: 1,
    });
    repo.listAttachmentKeys.mockResolvedValue(['a', 'b']);
    disk.list.mockResolvedValue([file('a', DAY), file('zz', DAY), file('yy', DAY)]);
    settings.get.mockResolvedValue(null);

    const r = await storageReport();

    expect(r.uploads).toEqual({ files: 3, bytes: 3000 });
    expect(r.exports).toEqual({ files: 1, bytes: 40 });
    expect(r.attachments).toEqual({
      active: 2,
      activeBytes: 2000,
      purged: 5,
      purged30d: 1,
      missing: 1, // 'b' não está no disco
      orphans: 2, // 'zz' e 'yy' não têm linha
    });
    expect(r.retentionDays).toBe(180);
    expect(r.purgeHour).toBe(4);
    expect(r.lastPurge).toBeNull();
  });
});
