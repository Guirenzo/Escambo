import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    textTarget: vi.fn(),
    removeContentAndClose: vi.fn(),
    hasOpenAccountReview: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock('./content-removals.repository', () => ({
  contentRemovalsRepository: { setQuarantineFile: vi.fn() },
}));
vi.mock('./moderation.strikes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./moderation.strikes')>()),
  strikePolicy: vi.fn(),
  strikeSummary: vi.fn(),
}));
vi.mock('../media/media.storage', () => ({
  readMediaFile: vi.fn(),
  deleteMediaImage: vi.fn(),
  quarantineMediaImage: vi.fn(),
}));
vi.mock('../media/media.image', () => ({ fingerprint: vi.fn() }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));
vi.mock('../messaging/messaging.service', () => ({
  messagingService: { announceChange: vi.fn() },
}));

import { fingerprint } from '../media/media.image';
import { deleteMediaImage, quarantineMediaImage, readMediaFile } from '../media/media.storage';
import { messagingService } from '../messaging/messaging.service';
import { notificationsService } from '../notifications/notifications.service';
import { contentRemovalsRepository } from './content-removals.repository';
import { strikePolicy, strikeSummary } from './moderation.strikes';
import { moderationService } from './reports.moderation';
import { reportsRepository } from './reports.repository';

const repo = vi.mocked(reportsRepository);
const removals = vi.mocked(contentRemovalsRepository);
const readFile = vi.mocked(readMediaFile);
const deleteImage = vi.mocked(deleteMediaImage);
const quarantine = vi.mocked(quarantineMediaImage);
const print = vi.mocked(fingerprint);
const notify = vi.mocked(notificationsService.notify);
const policy = vi.mocked(strikePolicy);
const summary = vi.mocked(strikeSummary);
const announce = vi.mocked(messagingService.announceChange);

const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
const KEY = '2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'));
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
  repo.removeImageAndClose.mockResolvedValue({ cleared: 1, reports: 2, removalId: 31 });
  repo.imageTarget.mockResolvedValue({ owner_id: 9, image_url: MEDIA, title: null } as never);
  repo.hasOpenAccountReview.mockResolvedValue(false);
  repo.create.mockResolvedValue(77);
  readFile.mockResolvedValue(Buffer.from('webp'));
  print.mockResolvedValue({ sha256: 'abc', dhash: 5n });
  quarantine.mockResolvedValue('31.webp');
  deleteImage.mockResolvedValue(true);
  notify.mockResolvedValue(undefined);
  policy.mockResolvedValue({
    appealWindowDays: 14,
    windowDays: 180,
    blockDays: 7,
    reviewThreshold: 3,
  });
  summary.mockResolvedValue({
    strikes: 1,
    imageStrikes: 1,
    windowDays: 180,
    reviewThreshold: 3,
    uploadsBlockedUntil: null,
  });
  announce.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(groups[1]).toMatchObject({ label: 'Serviço “Landing page”', imageLive: false });
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
      removalId: null,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    expect(repo.removeImageAndClose).not.toHaveBeenCalled();

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
});

describe('remoção contestável e reincidência (ADR 41)', () => {
  it('primeira remoção: registro, arquivo em quarentena e aviso com o prazo para contestar', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));

    const { result } = await moderationService.act(1, 4, 'remove-image', 'Imagem ofensiva.');

    expect(repo.removeImageAndClose).toHaveBeenCalledWith(
      expect.objectContaining({
        url: MEDIA,
        print: { sha256: 'abc', dhash: 5n },
        reportId: 4,
        ownerId: 9,
        reason: 'offensive',
        note: 'Imagem ofensiva.',
      }),
    );
    expect(quarantine).toHaveBeenCalledWith(KEY, 31);
    expect(removals.setQuarantineFile).toHaveBeenCalledWith(31, '31.webp');
    expect(deleteImage).not.toHaveBeenCalled();
    expect(summary).toHaveBeenCalledWith(9, new Date('2026-09-15T15:00:00Z'), expect.anything());
    expect(repo.create).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(9, {
      type: 'content_removed',
      title: 'Sua foto de perfil foi removida',
      body: 'A moderação removeu a imagem por conteúdo ofensivo. Imagem ofensiva. A mesma imagem não pode ser enviada de novo. Se discordar, conteste pelo seu perfil até 29/09/2026 às 12:00.',
      data: { contentRemoved: 'avatar', reportId: 4, removalId: 31 },
    });
    expect(result).toEqual({
      status: 'actioned',
      reports: 2,
      referencesCleared: 1,
      fileRemoved: true,
      blocked: true,
      removalId: 31,
      ownerStrikes: 1,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
  });

  it('no limite de reincidência: bloqueio no aviso e denúncia da conta aberta uma vez', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    summary.mockResolvedValue({
      strikes: 3,
      imageStrikes: 3,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: '2026-09-29T15:00:00.000Z',
    });

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.create).toHaveBeenCalledWith({
      reporterId: 1,
      targetType: 'user',
      targetId: 9,
      imageUrl: null,
      reason: 'other',
      description: 'Reincidência: 3 remoções de conteúdo nos últimos 180 dias. Revise a conta.',
    });
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        body: expect.stringContaining(
          'Como é a 3ª imagem removida nos últimos 180 dias, o envio de imagens fica bloqueado até 29/09/2026 às 12:00.',
        ),
      }),
    );
    expect(result).toMatchObject({
      ownerStrikes: 3,
      uploadsBlockedUntil: '2026-09-29T15:00:00.000Z',
      accountReviewOpened: true,
    });

    vi.clearAllMocks();
    repo.findById.mockResolvedValue(row({ id: 5 }));
    repo.removeImageAndClose.mockResolvedValue({ cleared: 1, reports: 1, removalId: 32 });
    repo.hasOpenAccountReview.mockResolvedValue(true);
    const again = await moderationService.act(1, 5, 'remove-image', null);
    expect(repo.create).not.toHaveBeenCalled();
    expect(again.result.accountReviewOpened).toBe(false);
  });

  it('link externo: registro contestável, sem arquivo para guardar nem bloquear', async () => {
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
    expect(quarantine).not.toHaveBeenCalled();
    expect(repo.removeImageAndClose).toHaveBeenCalledWith(expect.objectContaining({ print: null }));
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'A imagem do trabalho “Logo” foi removida',
        body: 'A moderação removeu a imagem por conteúdo ofensivo. Se discordar, conteste pelo seu perfil até 29/09/2026 às 12:00.',
      }),
    );
    expect(result).toMatchObject({ fileRemoved: false, blocked: false, removalId: 31 });
  });

  it('sem dono (trabalho apagado): a imagem sai de vez, sem registro nem aviso', async () => {
    repo.findById.mockResolvedValue(row({ target_type: 'portfolio_item', target_id: 3 }));
    repo.imageTarget.mockResolvedValue(undefined);
    repo.removeImageAndClose.mockResolvedValue({ cleared: 0, reports: 1, removalId: null });

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.removeImageAndClose).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: null }),
    );
    expect(quarantine).not.toHaveBeenCalled();
    expect(deleteImage).toHaveBeenCalledWith(KEY);
    expect(summary).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fileRemoved: true, removalId: null, ownerStrikes: null });
  });
});

describe('remoção de avaliação e mensagem (ADR 44)', () => {
  it('mensagem: sai do ar com cópia do texto, o autor é avisado com o prazo e o chat se atualiza', async () => {
    repo.findById.mockResolvedValue(
      row({
        id: 8,
        target_type: 'message',
        target_id: 55,
        image_url: null,
        reason: 'off_platform',
      }),
    );
    repo.textTarget.mockResolvedValue({
      owner_id: 12,
      text: 'Me paga no pix por fora',
      rating: null,
      file_name: null,
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValue({ reports: 2, removalId: 40 });
    summary.mockResolvedValue({
      strikes: 2,
      imageStrikes: 0,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });

    const { result, target } = await moderationService.act(
      1,
      8,
      'remove-content',
      'Pagamento por fora.',
    );

    expect(repo.textTarget).toHaveBeenCalledWith('message', 55);
    expect(repo.removeContentAndClose).toHaveBeenCalledWith({
      targetType: 'message',
      targetId: 55,
      imageUrl: null,
      adminId: 1,
      note: 'Pagamento por fora.',
      reportId: 8,
      reason: 'off_platform',
      author: { id: 12, snapshot: 'Me paga no pix por fora' },
    });
    expect(notify).toHaveBeenCalledWith(12, {
      type: 'content_removed',
      title: 'Uma mensagem sua no chat foi removida',
      body: 'A moderação removeu a mensagem por negociação fora da plataforma. Pagamento por fora. Se discordar, conteste pelo seu perfil até 29/09/2026 às 12:00.',
      data: { contentRemoved: 'message', reportId: 8, removalId: 40 },
    });
    expect(announce).toHaveBeenCalledWith(55);
    expect(readFile).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'actioned',
      reports: 2,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
      removalId: 40,
      ownerStrikes: 2,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    expect(target).toEqual({ type: 'message', id: 55, imageUrl: null });
  });

  it('avaliação: a cópia leva a nota, e a terceira remoção de qualquer conteúdo abre a revisão da conta', async () => {
    repo.findById.mockResolvedValue(
      row({ id: 9, target_type: 'review', target_id: 21, image_url: null }),
    );
    repo.textTarget.mockResolvedValue({
      owner_id: 12,
      text: 'Péssimo, um golpista',
      rating: 1,
      file_name: null,
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValue({ reports: 1, removalId: 41 });
    summary.mockResolvedValue({
      strikes: 3,
      imageStrikes: 1,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });

    const { result } = await moderationService.act(1, 9, 'remove-content', null);

    expect(repo.removeContentAndClose).toHaveBeenCalledWith(
      expect.objectContaining({
        author: { id: 12, snapshot: 'Nota 1 de 5. Péssimo, um golpista' },
      }),
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'user',
        targetId: 12,
        description: 'Reincidência: 3 remoções de conteúdo nos últimos 180 dias. Revise a conta.',
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ title: 'Sua avaliação foi removida' }),
    );
    expect(announce).not.toHaveBeenCalled();
    expect(result).toMatchObject({ removalId: 41, ownerStrikes: 3, accountReviewOpened: true });
  });

  it('conteúdo que já saiu do ar só fecha as denúncias; denúncia que não é de texto é 422', async () => {
    repo.findById.mockResolvedValueOnce(
      row({ id: 9, target_type: 'review', target_id: 21, image_url: null }),
    );
    repo.textTarget.mockResolvedValueOnce({
      owner_id: 12,
      text: 'x',
      rating: 2,
      file_name: null,
      removed_at: new Date(),
    } as never);
    repo.removeContentAndClose.mockResolvedValueOnce({ reports: 1, removalId: null });

    const { result } = await moderationService.act(1, 9, 'remove-content', null);

    expect(repo.removeContentAndClose).toHaveBeenCalledWith(
      expect.objectContaining({ author: null }),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reports: 1, removalId: null, ownerStrikes: null });

    repo.findById.mockResolvedValueOnce(row({ id: 4 }));
    await expect(moderationService.act(1, 4, 'remove-content', null)).rejects.toMatchObject({
      statusCode: 422,
      code: 'not_a_content_report',
    });
  });
});
