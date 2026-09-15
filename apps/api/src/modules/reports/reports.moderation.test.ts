import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./reports.repository', () => ({
  reportsRepository: {
    listForModeration: vi.fn(),
    usersByIds: vi.fn(),
    portfolioByIds: vi.fn(),
    servicesByIds: vi.fn(),
    reviewsByIds: vi.fn(),
    messagesByIds: vi.fn(),
    findById: vi.fn(),
    closeGroup: vi.fn(),
    removeImageAndClose: vi.fn(),
    imageTarget: vi.fn(),
  },
}));
vi.mock('../media/media.storage', () => ({ readMediaFile: vi.fn(), deleteMediaImage: vi.fn() }));
vi.mock('../media/media.image', () => ({ fingerprint: vi.fn() }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { fingerprint } from '../media/media.image';
import { deleteMediaImage, readMediaFile } from '../media/media.storage';
import { notificationsService } from '../notifications/notifications.service';
import { moderationService } from './reports.moderation';
import { reportsRepository } from './reports.repository';

const repo = vi.mocked(reportsRepository);
const readFile = vi.mocked(readMediaFile);
const deleteImage = vi.mocked(deleteMediaImage);
const print = vi.mocked(fingerprint);
const notify = vi.mocked(notificationsService.notify);

const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
const OLD_MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CE.webp';

const row = (o: Record<string, unknown> = {}) =>
  ({
    id: 1,
    reporter_id: 50,
    target_type: 'avatar',
    target_id: 9,
    image_url: MEDIA,
    reason: 'offensive',
    description: null,
    status: 'pending',
    reviewed_at: null,
    resolution_note: null,
    created_at: new Date('2026-09-15T10:00:00Z'),
    ...o,
  }) as never;
const info = (o: Record<string, unknown> = {}) =>
  ({
    id: 9,
    owner_id: 9,
    owner_ulid: '01OWNER0000000000000000000',
    owner_name: 'Bruno Costa',
    title: null,
    image_url: MEDIA,
    ...o,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    repo.usersByIds,
    repo.portfolioByIds,
    repo.servicesByIds,
    repo.reviewsByIds,
    repo.messagesByIds,
  ]) {
    fn.mockResolvedValue([]);
  }
  repo.closeGroup.mockResolvedValue(1);
  repo.removeImageAndClose.mockResolvedValue({ cleared: 1, reports: 2 });
  repo.imageTarget.mockResolvedValue({ owner_id: 9, image_url: MEDIA, title: null } as never);
  readFile.mockResolvedValue(Buffer.from('webp'));
  print.mockResolvedValue({ sha256: 'abc', dhash: 5n });
  deleteImage.mockResolvedValue(true);
  notify.mockResolvedValue(undefined);
});

describe('fila de moderação (ADR 39)', () => {
  it('agrupa por alvo e imagem, conta motivos e põe as mais denunciadas primeiro', async () => {
    repo.listForModeration.mockResolvedValue([
      row({
        id: 4,
        reason: 'fraud',
        description: 'foto de outra pessoa',
        created_at: new Date('2026-09-15T12:00:00Z'),
      }),
      row({
        id: 3,
        target_type: 'service',
        target_id: 7,
        image_url: null,
        reason: 'spam',
        created_at: new Date('2026-09-15T11:30:00Z'),
      }),
      row({ id: 2, created_at: new Date('2026-09-15T11:00:00Z') }),
      row({ id: 1, image_url: OLD_MEDIA, created_at: new Date('2026-09-15T10:00:00Z') }),
    ]);
    repo.usersByIds.mockResolvedValue([info()]);
    repo.servicesByIds.mockResolvedValue([info({ id: 7, title: 'Landing page', image_url: null })]);

    const groups = await moderationService.listQueue('pending');

    expect(repo.listForModeration).toHaveBeenCalledWith('pending', 500);
    expect(repo.usersByIds).toHaveBeenCalledWith([9]);
    expect(groups.map((g) => g.id)).toEqual([4, 3, 1]);
    expect(groups[0]).toMatchObject({
      targetType: 'avatar',
      imageUrl: MEDIA,
      imageLive: true,
      label: 'Foto de perfil',
      owner: { id: 9, ulid: '01OWNER0000000000000000000', name: 'Bruno Costa' },
      status: 'pending',
      reports: 2,
      descriptions: ['foto de outra pessoa'],
      firstReportedAt: '2026-09-15T11:00:00.000Z',
      lastReportedAt: '2026-09-15T12:00:00.000Z',
    });
    expect(groups[0]!.reasons).toEqual(
      expect.arrayContaining([
        { reason: 'fraud', count: 1 },
        { reason: 'offensive', count: 1 },
      ]),
    );
    expect(groups[1]).toMatchObject({ label: 'Serviço “Landing page”', imageLive: false });
    // A foto antiga já foi trocada: continua na fila, mas não está mais no ar.
    expect(groups[2]).toMatchObject({ imageUrl: OLD_MEDIA, imageLive: false, reports: 1 });
  });

  it('dispensar e resolver só fecham o grupo; decisão repetida é 409 e denúncia inexistente 404', async () => {
    repo.findById.mockResolvedValueOnce(row({ id: 4 }));
    const dismissed = await moderationService.act(1, 4, 'dismiss', 'Não é ofensiva.');
    expect(repo.closeGroup).toHaveBeenCalledWith({
      targetType: 'avatar',
      targetId: 9,
      imageUrl: MEDIA,
      adminId: 1,
      note: 'Não é ofensiva.',
      status: 'dismissed',
    });
    expect(dismissed.result).toEqual({
      status: 'dismissed',
      reports: 1,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
    });
    expect(repo.removeImageAndClose).not.toHaveBeenCalled();

    repo.findById.mockResolvedValueOnce(row({ target_type: 'user', image_url: null }));
    expect((await moderationService.act(1, 5, 'resolve', null)).result.status).toBe('actioned');

    repo.findById.mockResolvedValueOnce(row({ status: 'dismissed' }));
    await expect(moderationService.act(1, 4, 'dismiss', null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'report_already_resolved',
    });
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(moderationService.act(1, 99, 'dismiss', null)).rejects.toMatchObject({
      statusCode: 404,
    });
    repo.findById.mockResolvedValueOnce(row({ target_type: 'service', image_url: null }));
    await expect(moderationService.act(1, 3, 'remove-image', null)).rejects.toMatchObject({
      statusCode: 422,
      code: 'not_an_image_report',
    });
  });

  it('remover foto enviada: impressão antes de apagar, transação, arquivo apagado e dono avisado', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));

    const { result, target } = await moderationService.act(
      1,
      4,
      'remove-image',
      'Imagem ofensiva.',
    );

    expect(readFile).toHaveBeenCalledWith('2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp');
    expect(repo.removeImageAndClose).toHaveBeenCalledWith(
      expect.objectContaining({
        url: MEDIA,
        print: { sha256: 'abc', dhash: 5n },
        reportId: 4,
        adminId: 1,
        note: 'Imagem ofensiva.',
      }),
    );
    expect(deleteImage).toHaveBeenCalledWith('2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp');
    expect(notify).toHaveBeenCalledWith(9, {
      type: 'content_removed',
      title: 'Sua foto de perfil foi removida',
      body: 'A moderação removeu a imagem por conteúdo ofensivo. Imagem ofensiva. A mesma imagem não pode ser enviada de novo; você pode escolher outra no perfil.',
      data: { contentRemoved: 'avatar', reportId: 4 },
    });
    expect(result).toEqual({
      status: 'actioned',
      reports: 2,
      referencesCleared: 1,
      fileRemoved: true,
      blocked: true,
    });
    expect(target).toEqual({ type: 'avatar', id: 9, imageUrl: MEDIA });
  });

  it('imagem de link externo: some do perfil, mas não há arquivo para apagar nem bloquear', async () => {
    repo.findById.mockResolvedValue(
      row({ target_type: 'portfolio_item', target_id: 3, image_url: 'https://i.pravatar.cc/150' }),
    );
    repo.imageTarget.mockResolvedValue({
      owner_id: 9,
      image_url: 'https://i.pravatar.cc/150',
      title: 'Logo',
    } as never);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(readFile).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
    expect(repo.removeImageAndClose).toHaveBeenCalledWith(expect.objectContaining({ print: null }));
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'A imagem do trabalho “Logo” foi removida',
        body: 'A moderação removeu a imagem por conteúdo ofensivo. Você pode escolher outra imagem no perfil.',
      }),
    );
    expect(result).toMatchObject({ fileRemoved: false, blocked: false, referencesCleared: 1 });
  });
});
