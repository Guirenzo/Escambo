import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./image-removals.repository', () => ({
  imageRemovalsRepository: {
    findById: vi.fn(),
    listForOwner: vi.fn(),
    appeal: vi.fn(),
    uphold: vi.fn(),
    overturn: vi.fn(),
    markFilePurged: vi.fn(),
    listQuarantineToPurge: vi.fn(),
  },
}));
vi.mock('./moderation.strikes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./moderation.strikes')>()),
  strikePolicy: vi.fn(),
  strikeSummary: vi.fn(),
}));
vi.mock('../media/media.storage', () => ({
  deleteQuarantined: vi.fn(),
  quarantineFilePath: vi.fn(),
  restoreQuarantined: vi.fn(),
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { deleteQuarantined, restoreQuarantined } from '../media/media.storage';
import { notificationsService } from '../notifications/notifications.service';
import { appealsService } from './appeals.service';
import { imageRemovalsRepository } from './image-removals.repository';
import { strikePolicy, strikeSummary } from './moderation.strikes';

const repo = vi.mocked(imageRemovalsRepository);
const policy = vi.mocked(strikePolicy);
const summary = vi.mocked(strikeSummary);
const notify = vi.mocked(notificationsService.notify);
const restore = vi.mocked(restoreQuarantined);
const removeFile = vi.mocked(deleteQuarantined);

const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
const NOW = new Date('2026-09-20T12:00:00Z');

const removal = (o: Record<string, unknown> = {}) =>
  ({
    id: 31,
    report_id: 4,
    owner_id: 9,
    target_type: 'avatar',
    target_id: 9,
    image_url: MEDIA,
    reason: 'offensive',
    note: 'Imagem ofensiva.',
    cleared_refs: [{ table: 'profiles_freelancer', id: 2 }],
    quarantine_file: '31.webp',
    blocklist_id: 7,
    removed_by: 1,
    removed_at: new Date('2026-09-15T12:00:00Z'),
    status: 'removed',
    appeal_text: null,
    appealed_at: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    file_purged_at: null,
    work_title: null,
    ...o,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  policy.mockResolvedValue({
    appealWindowDays: 14,
    windowDays: 180,
    blockDays: 7,
    reviewThreshold: 3,
  });
  summary.mockResolvedValue({
    strikes: 1,
    windowDays: 180,
    reviewThreshold: 3,
    uploadsBlockedUntil: null,
  });
  repo.appeal.mockResolvedValue(true);
  repo.uphold.mockResolvedValue(true);
  repo.overturn.mockResolvedValue({ decided: true, restored: 1 });
  restore.mockResolvedValue(true);
  removeFile.mockResolvedValue(true);
  notify.mockResolvedValue(undefined);
});

describe('contestação de remoção de imagem (ADR 41)', () => {
  it('o dono vê as remoções com prazo; só contesta a sua, uma vez e dentro do prazo', async () => {
    repo.listForOwner.mockResolvedValue([
      removal(),
      removal({ id: 30, removed_at: new Date('2026-09-01T12:00:00Z') }),
    ]);
    const mine = await appealsService.mine(9, NOW);
    expect(mine.removals.map((r) => [r.id, r.canAppeal, r.appealDeadline])).toEqual([
      [31, true, '2026-09-29T12:00:00.000Z'],
      [30, false, '2026-09-15T12:00:00.000Z'],
    ]);
    expect(mine.removals[0]).toMatchObject({ label: 'Foto de perfil', reason: 'offensive' });
    expect(mine.strikes.strikes).toBe(1);

    repo.findById.mockResolvedValueOnce(removal({ owner_id: 99 }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 404,
    });
    repo.findById.mockResolvedValueOnce(removal({ status: 'appealed' }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'appeal_exists',
    });
    repo.findById.mockResolvedValueOnce(removal({ removed_at: new Date('2026-09-01T12:00:00Z') }));
    await expect(appealsService.appeal(9, 31, 'texto', NOW)).rejects.toMatchObject({
      statusCode: 410,
      code: 'appeal_window_closed',
    });
    expect(repo.appeal).not.toHaveBeenCalled();

    repo.findById
      .mockResolvedValueOnce(removal())
      .mockResolvedValueOnce(removal({ status: 'appealed', appeal_text: 'É a minha foto.' }));
    const appealed = await appealsService.appeal(9, 31, 'É a minha foto.', NOW);
    expect(repo.appeal).toHaveBeenCalledWith(31, 9, 'É a minha foto.');
    expect(appealed).toMatchObject({
      status: 'appealed',
      canAppeal: false,
      appealText: 'É a minha foto.',
    });
  });

  it('manter apaga o arquivo da quarentena e avisa o dono', async () => {
    repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
    const r = await appealsService.decide(1, 31, 'uphold', 'Continua ofensiva.');
    expect(repo.uphold).toHaveBeenCalledWith(31, 1, 'Continua ofensiva.');
    expect(removeFile).toHaveBeenCalledWith('31.webp');
    expect(repo.markFilePurged).toHaveBeenCalledWith(31);
    expect(notify).toHaveBeenCalledWith(9, {
      type: 'appeal_decided',
      title: 'Contestação analisada: a remoção foi mantida',
      body: 'Foto de perfil continua fora do ar. Continua ofensiva.',
      data: { imageRemovalId: 31, decision: 'upheld' },
    });
    expect(r).toEqual({
      status: 'upheld',
      restoredReferences: 0,
      imageRestored: false,
      fileDeleted: true,
    });
  });

  it('reverter devolve o arquivo antes, recoloca a imagem e tira do bloqueio', async () => {
    repo.findById.mockResolvedValue(removal({ status: 'appealed' }));
    const r = await appealsService.decide(1, 31, 'overturn', 'Foto legítima.');
    expect(restore).toHaveBeenCalledWith('31.webp', '2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp');
    expect(repo.overturn).toHaveBeenCalledWith({
      id: 31,
      adminId: 1,
      note: 'Foto legítima.',
      url: MEDIA,
      refs: [{ table: 'profiles_freelancer', id: 2 }],
      blocklistId: 7,
      restoreRefs: true,
      fileBack: true,
    });
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'Contestação aceita: sua imagem voltou',
        body: 'Foto de perfil voltou ao seu perfil e a remoção deixou de contar como ocorrência. Foto legítima.',
      }),
    );
    expect(r).toEqual({
      status: 'overturned',
      restoredReferences: 1,
      imageRestored: true,
      fileDeleted: false,
    });
  });

  it('reverter sem arquivo não recoloca referência quebrada; decisão fora de hora é 409', async () => {
    repo.findById.mockResolvedValueOnce(
      removal({ status: 'appealed', file_purged_at: new Date() }),
    );
    repo.overturn.mockResolvedValueOnce({ decided: true, restored: 0 });
    const r = await appealsService.decide(1, 31, 'overturn', null);
    expect(restore).not.toHaveBeenCalled();
    expect(repo.overturn).toHaveBeenCalledWith(
      expect.objectContaining({ restoreRefs: false, fileBack: false }),
    );
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'Contestação aceita',
        body: 'A remoção foi revertida e deixou de contar como ocorrência. A imagem não pôde ser recuperada; envie de novo pelo perfil.',
      }),
    );
    expect(r.imageRestored).toBe(false);

    repo.findById.mockResolvedValueOnce(removal({ status: 'upheld' }));
    await expect(appealsService.decide(1, 31, 'overturn', null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'appeal_not_pending',
    });
  });

  it('expurgo da quarentena usa o prazo de contestação', async () => {
    repo.listQuarantineToPurge.mockResolvedValue([
      removal(),
      removal({ id: 32, quarantine_file: '32.png' }),
    ]);
    expect(await appealsService.purgeQuarantine(NOW)).toBe(2);
    expect(repo.listQuarantineToPurge).toHaveBeenCalledWith(new Date('2026-09-06T12:00:00Z'), 500);
    expect(removeFile).toHaveBeenCalledWith('32.png');
    expect(repo.markFilePurged).toHaveBeenCalledTimes(2);
  });
});
