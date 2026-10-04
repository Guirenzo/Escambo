import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

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
  deleteQuarantined: vi.fn(),
  quarantineMediaImage: vi.fn(),
}));
vi.mock('../../config/sentry', () => ({ captureError: vi.fn() }));
vi.mock('../media/media.image', () => ({ fingerprint: vi.fn() }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));
vi.mock('../messaging/messaging.service', () => ({
  messagingService: { announceChange: vi.fn() },
}));
vi.mock('../auth/auth.repository', () => ({
  authRepository: { findById: vi.fn() },
}));

import { logger } from '../../config/logger';
import { captureError } from '../../config/sentry';
import { authRepository } from '../auth/auth.repository';
import { fingerprint } from '../media/media.image';
import {
  deleteMediaImage,
  deleteQuarantined,
  quarantineMediaImage,
  readMediaFile,
} from '../media/media.storage';
import { messagingService } from '../messaging/messaging.service';
import { notificationsService } from '../notifications/notifications.service';
import { contentRemovalsRepository } from './content-removals.repository';
import { strikePolicy, strikeSummary } from './moderation.strikes';
import { contentSnapshot, moderationService } from './reports.moderation';
import { reportsRepository } from './reports.repository';

const repo = vi.mocked(reportsRepository);
const removals = vi.mocked(contentRemovalsRepository);
const readFile = vi.mocked(readMediaFile);
const deleteImage = vi.mocked(deleteMediaImage);
const quarantine = vi.mocked(quarantineMediaImage);
const dropQuarantined = vi.mocked(deleteQuarantined);
const sentry = vi.mocked(captureError);
const print = vi.mocked(fingerprint);
const notify = vi.mocked(notificationsService.notify);
const policy = vi.mocked(strikePolicy);
const summary = vi.mocked(strikeSummary);
const announce = vi.mocked(messagingService.announceChange);
const users = vi.mocked(authRepository);

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

const POLICY = { appealWindowDays: 14, windowDays: 180, blockDays: 7, reviewThreshold: 3 };
/** Posição da primeira chamada na ordem global dos mocks, para conferir o que vem antes do quê. */
const firstCall = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'));
  vi.resetAllMocks();
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
  users.findById.mockResolvedValue({ timezone: null } as never);
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
      automatic: false,
      reports: 2,
      descriptions: ['foto de outra pessoa'],
      firstReportedAt: '2026-09-15T11:00:00.000Z',
      lastReportedAt: '2026-09-15T12:00:00.000Z',
    });
    expect(groups[1]).toMatchObject({ label: 'Serviço “Landing page”', imageLive: false });
    expect(groups[2]).toMatchObject({ imageUrl: OLD_MEDIA, imageLive: false, reports: 1 });
  });

  it('denúncia automática marca o grupo, sem denunciante (ADR 45)', async () => {
    repo.listForModeration.mockResolvedValue([
      row({
        id: 6,
        reporter_id: null,
        target_type: 'message',
        target_id: 8,
        image_url: null,
        reason: 'off_platform',
        description: 'Sinalizado automaticamente: Pix.',
      }),
    ]);
    repo.messagesByIds.mockResolvedValue([
      info({ id: 8, title: 'me paga no pix', image_url: null }),
    ]);

    const [group] = await moderationService.listQueue('pending');

    expect(group).toMatchObject({
      label: 'Mensagem no chat',
      excerpt: 'me paga no pix',
      automatic: true,
      reports: 1,
      descriptions: ['Sinalizado automaticamente: Pix.'],
    });
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
    // A impressão é a dos bytes do arquivo denunciado, lidos antes de ele sair do ar; a quarentena
    // só vem depois do registro, porque o nome do arquivo guardado é o id da remoção.
    expect(readFile).toHaveBeenCalledWith(KEY);
    expect(print).toHaveBeenCalledWith(Buffer.from('webp'));
    expect(firstCall(readFile)).toBeLessThan(firstCall(repo.removeImageAndClose));
    expect(firstCall(repo.removeImageAndClose)).toBeLessThan(firstCall(quarantine));
    // A reincidência é a do dono, agora, com a política lida da configuração.
    expect(summary).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledWith(9, new Date('2026-09-15T15:00:00Z'), POLICY);
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

  it('o prazo no aviso sai no fuso do dono (ADR 46)', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    users.findById.mockResolvedValue({ timezone: 'America/Manaus' } as never);

    await moderationService.act(1, 4, 'remove-image', null);

    expect(users.findById).toHaveBeenCalledWith(9);
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ body: expect.stringContaining('até 29/09/2026 às 11:00.') }),
    );
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

    // A revisão que não pode repetir é a da conta do dono, não a do admin que decidiu.
    expect(repo.hasOpenAccountReview).toHaveBeenCalledTimes(1);
    expect(repo.hasOpenAccountReview).toHaveBeenCalledWith(9);
    expect(repo.create).toHaveBeenCalledTimes(1);
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
    expect(repo.hasOpenAccountReview).toHaveBeenCalledWith(9);
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
    // Reincidência e fuso do aviso são os do autor da mensagem, não os do admin nem do denunciante.
    expect(summary).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledWith(12, new Date('2026-09-15T15:00:00Z'), POLICY);
    expect(users.findById).toHaveBeenCalledWith(12);
    expect(notify).toHaveBeenCalledTimes(1);
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

describe('fila de moderação: rótulos, trechos e resolvidas (ADR 39 e 44)', () => {
  it('cada tipo de alvo ganha o seu rótulo, com o título quando existe', async () => {
    repo.listForModeration.mockResolvedValue([
      row({ id: 6, target_type: 'portfolio_item', target_id: 3 }),
      row({ id: 5, target_type: 'portfolio_item', target_id: 4 }),
      row({ id: 4, target_type: 'service', target_id: 7, image_url: null }),
      row({ id: 3, target_type: 'review', target_id: 21, image_url: null }),
      row({ id: 2, target_type: 'user', target_id: 9, image_url: null }),
      // Alvo que já não existe: sem descrição nem dono.
      row({ id: 1, target_type: 'portfolio_item', target_id: 99 }),
    ]);
    repo.usersByIds.mockResolvedValue([info()]);
    repo.portfolioByIds.mockResolvedValue([
      info({ id: 3, title: 'Logo' }),
      info({ id: 4, title: null, image_url: OLD_MEDIA }),
    ]);
    repo.servicesByIds.mockResolvedValue([info({ id: 7, title: null, image_url: null })]);
    repo.reviewsByIds.mockResolvedValue([info({ id: 21, title: '  Péssimo  ', image_url: null })]);

    const groups = await moderationService.listQueue('pending');

    // Cada consulta recebe só os ids do seu tipo, sem repetir.
    expect(repo.usersByIds).toHaveBeenCalledWith([9]);
    expect(repo.portfolioByIds).toHaveBeenCalledWith([3, 4, 99]);
    expect(repo.servicesByIds).toHaveBeenCalledWith([7]);
    expect(repo.reviewsByIds).toHaveBeenCalledWith([21]);
    expect(repo.messagesByIds).toHaveBeenCalledWith([]);

    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get(6)).toMatchObject({ label: 'Imagem do trabalho “Logo”', imageLive: true });
    // A imagem denunciada já foi trocada: a do ar agora é outra.
    expect(byId.get(5)).toMatchObject({ label: 'Imagem do portfólio', imageLive: false });
    expect(byId.get(4)).toMatchObject({ label: 'Serviço', excerpt: null, imageLive: false });
    expect(byId.get(3)).toMatchObject({ label: 'Avaliação', excerpt: 'Péssimo' });
    expect(byId.get(2)).toMatchObject({ label: 'Perfil', excerpt: null, imageUrl: null });
    expect(byId.get(1)).toMatchObject({
      label: 'Imagem do portfólio',
      owner: null,
      imageLive: false,
    });
  });

  it('o trecho do texto denunciado é cortado em 280 caracteres; texto em branco não vira trecho', async () => {
    repo.listForModeration.mockResolvedValue([
      row({ id: 3, target_type: 'message', target_id: 55, image_url: null }),
      row({ id: 2, target_type: 'message', target_id: 56, image_url: null }),
      row({ id: 1, target_type: 'review', target_id: 21, image_url: null }),
    ]);
    repo.messagesByIds.mockResolvedValue([
      info({ id: 55, title: 'a'.repeat(281), image_url: null }),
      info({ id: 56, title: 'b'.repeat(280), image_url: null }),
    ]);
    repo.reviewsByIds.mockResolvedValue([info({ id: 21, title: '   ', image_url: null })]);

    const groups = await moderationService.listQueue('pending');
    const byId = new Map(groups.map((g) => [g.id, g]));

    expect(byId.get(3)!.excerpt).toBe(`${'a'.repeat(279)}…`);
    expect(byId.get(3)!.excerpt).toHaveLength(280);
    expect(byId.get(2)!.excerpt).toBe('b'.repeat(280));
    expect(byId.get(1)!.excerpt).toBeNull();
  });

  it('o grupo mostra os motivos do mais citado para o menos, até três descrições e "em análise" como pendente', async () => {
    repo.listForModeration.mockResolvedValue([
      row({ id: 6, reason: 'spam', description: '  d6  ', status: 'reviewing' }),
      row({ id: 5, reason: 'offensive', description: '   ' }),
      row({ id: 4, reason: 'offensive', description: 'd4' }),
      row({ id: 3, reason: 'fraud', description: 'd3' }),
      row({ id: 2, reason: 'offensive', description: 'd2' }),
      row({ id: 1, reason: 'spam', description: null }),
    ]);
    repo.usersByIds.mockResolvedValue([info({ owner_ulid: null })]);

    const [group, ...rest] = await moderationService.listQueue('pending');

    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({
      id: 6,
      status: 'pending',
      reports: 6,
      reasons: [
        { reason: 'offensive', count: 3 },
        { reason: 'spam', count: 2 },
        { reason: 'fraud', count: 1 },
      ],
      descriptions: ['d6', 'd4', 'd3'],
      reviewedAt: null,
      resolutionNote: null,
      // Dono sem ULID (conta apagada) não vira link para o perfil.
      owner: null,
    });
  });

  it('resolvidas: cada decisão é um grupo, mesmo do mesmo alvo, e as mais recentes vêm primeiro', async () => {
    const first = new Date('2026-09-10T12:00:00Z');
    const second = new Date('2026-09-14T12:00:00Z');
    repo.listForModeration.mockResolvedValue([
      // Mesmo alvo e mesma imagem, decididos em dois momentos.
      row({ id: 5, status: 'dismissed', reviewed_at: first, resolution_note: 'Não é ofensiva.' }),
      row({ id: 4, status: 'actioned', reviewed_at: second, resolution_note: 'Removida.' }),
      row({ id: 3, status: 'actioned', reviewed_at: second, resolution_note: 'Removida.' }),
      row({ id: 2, status: 'dismissed', reviewed_at: first, resolution_note: 'Não é ofensiva.' }),
    ]);
    repo.usersByIds.mockResolvedValue([info()]);

    const groups = await moderationService.listQueue('resolved');

    expect(repo.listForModeration).toHaveBeenCalledWith('resolved', 500);
    expect(groups.map((g) => [g.id, g.status, g.reports, g.reviewedAt, g.resolutionNote])).toEqual([
      [4, 'actioned', 2, '2026-09-14T12:00:00.000Z', 'Removida.'],
      [5, 'dismissed', 2, '2026-09-10T12:00:00.000Z', 'Não é ofensiva.'],
    ]);
  });

  it('pendentes com o mesmo número de denúncias: a denunciada por último vem primeiro', async () => {
    // Fora da ordem do banco de propósito: quem desempata é a data, não a posição da linha.
    repo.listForModeration.mockResolvedValue([
      row({ id: 1, target_id: 9, created_at: new Date('2026-09-15T10:00:00Z') }),
      row({ id: 2, target_id: 12, created_at: new Date('2026-09-15T12:00:00Z') }),
    ]);

    const groups = await moderationService.listQueue('pending');

    expect(groups.map((g) => g.id)).toEqual([2, 1]);
    expect(repo.usersByIds).toHaveBeenCalledWith([9, 12]);
  });
});

describe('cópia do texto removido (ADR 44)', () => {
  it('avaliação leva a nota na frente; sem comentário fica só a nota', () => {
    expect(contentSnapshot('review', { text: '  Ruim  ', rating: 2, file_name: null })).toBe(
      'Nota 2 de 5. Ruim',
    );
    expect(contentSnapshot('review', { text: null, rating: 4, file_name: null })).toBe(
      'Nota 4 de 5.',
    );
    expect(contentSnapshot('review', { text: 'Ruim', rating: null, file_name: null })).toBe(
      'Nota ? de 5. Ruim',
    );
  });

  it('mensagem sem texto guarda o nome do anexo, ou avisa que não tinha texto', () => {
    expect(contentSnapshot('message', { text: 'Oi', rating: null, file_name: 'a.pdf' })).toBe('Oi');
    expect(contentSnapshot('message', { text: '   ', rating: null, file_name: 'a.pdf' })).toBe(
      'Anexo: a.pdf',
    );
    expect(contentSnapshot('message', { text: null, rating: null, file_name: null })).toBe(
      '(mensagem sem texto)',
    );
  });

  it('a cópia cabe em 1000 caracteres: o excesso é cortado com reticências', () => {
    const exact = contentSnapshot('message', {
      text: 'x'.repeat(1000),
      rating: null,
      file_name: null,
    });
    expect(exact).toBe('x'.repeat(1000));

    const long = contentSnapshot('message', {
      text: 'x'.repeat(1001),
      rating: null,
      file_name: null,
    });
    expect(long).toHaveLength(1000);
    expect(long).toBe(`${'x'.repeat(999)}…`);
  });
});

describe('decisões da fila: o que os casos acima não cobrem', () => {
  it('resolver fecha o grupo como "com ação", sem remover nada', async () => {
    repo.findById.mockResolvedValue(
      row({ id: 3, target_type: 'service', target_id: 7, image_url: null, status: 'reviewing' }),
    );
    repo.closeGroup.mockResolvedValue(4);

    const { result, target } = await moderationService.act(1, 3, 'resolve', null);

    expect(repo.findById).toHaveBeenCalledWith(3);
    expect(repo.closeGroup).toHaveBeenCalledWith({
      targetType: 'service',
      targetId: 7,
      imageUrl: null,
      adminId: 1,
      note: null,
      status: 'actioned',
    });
    expect(result).toEqual({
      status: 'actioned',
      reports: 4,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
      removalId: null,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    expect(target).toEqual({ type: 'service', id: 7, imageUrl: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it('arquivo que não vai para a quarentena (sumiu do disco): a remoção vale, sem anotar arquivo', async () => {
    repo.findById.mockResolvedValue(row({ id: 4, target_type: 'portfolio_item', target_id: 3 }));
    repo.imageTarget.mockResolvedValue({ owner_id: 9, image_url: MEDIA, title: null } as never);
    readFile.mockResolvedValue(null);
    quarantine.mockResolvedValue(null);
    // A exclusão de reserva também não acha o arquivo.
    deleteImage.mockResolvedValue(false);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.imageTarget).toHaveBeenCalledWith('portfolio_item', 3);
    expect(readFile).toHaveBeenCalledWith(KEY);
    // Sem os bytes não há impressão: a imagem sai, mas não entra na lista de bloqueio.
    expect(print).not.toHaveBeenCalled();
    expect(repo.removeImageAndClose).toHaveBeenCalledWith({
      targetType: 'portfolio_item',
      targetId: 3,
      imageUrl: MEDIA,
      adminId: 1,
      note: null,
      url: MEDIA,
      print: null,
      reportId: 4,
      ownerId: 9,
      reason: 'offensive',
    });
    expect(quarantine).toHaveBeenCalledWith(KEY, 31);
    expect(removals.setQuarantineFile).not.toHaveBeenCalled();
    expect(deleteImage.mock.calls).toEqual([[KEY]]);
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        title: 'Uma imagem do seu portfólio foi removida',
        body: 'A moderação removeu a imagem por conteúdo ofensivo. Se discordar, conteste pelo seu perfil até 29/09/2026 às 12:00.',
      }),
    );
    expect(result).toMatchObject({ fileRemoved: false, blocked: false, removalId: 31 });
  });

  it('o arquivo não foi para a quarentena mas continua no disco (rename falhou): sai de vez, para a URL não servir a imagem removida', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    quarantine.mockResolvedValue(null);
    deleteImage.mockResolvedValue(true);
    const warn = vi.spyOn(logger, 'warn');

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(quarantine.mock.calls).toEqual([[KEY, 31]]);
    // Só depois de a quarentena falhar, e sem anotar arquivo na remoção: a reversão diz que a
    // imagem não pôde ser recuperada.
    expect(deleteImage.mock.calls).toEqual([[KEY]]);
    expect(firstCall(deleteImage)).toBeGreaterThan(firstCall(quarantine));
    expect(removals.setQuarantineFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'actioned', removalId: 31, fileRemoved: true });
    expect(warn).toHaveBeenCalledWith(
      { reportId: 4, removalId: 31, key: KEY },
      'moderação: quarentena falhou; arquivo apagado de vez, a contestação não o recupera',
    );
    warn.mockRestore();
  });

  it('motivo fora da lista sai no aviso como violação das regras', async () => {
    repo.findById.mockResolvedValue(row({ id: 4, reason: 'motivo_antigo' }));

    await moderationService.act(1, 4, 'remove-image', null);

    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        body: expect.stringContaining(
          'A moderação removeu a imagem por violar as regras do Escambo.',
        ),
      }),
    );
  });

  it('conteúdo que já não existe só fecha as denúncias; falha ao avisar o chat não desfaz a remoção', async () => {
    repo.findById.mockResolvedValueOnce(
      row({ id: 8, target_type: 'message', target_id: 55, image_url: null }),
    );
    repo.textTarget.mockResolvedValueOnce(undefined);
    repo.removeContentAndClose.mockResolvedValueOnce({ reports: 1, removalId: null });

    const gone = await moderationService.act(1, 8, 'remove-content', null);

    expect(repo.removeContentAndClose).toHaveBeenCalledWith(
      expect.objectContaining({ author: null }),
    );
    expect(gone.result).toMatchObject({ status: 'actioned', reports: 1, removalId: null });
    expect(notify).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();

    repo.findById.mockResolvedValueOnce(
      row({ id: 8, target_type: 'message', target_id: 55, image_url: null }),
    );
    repo.textTarget.mockResolvedValueOnce({
      owner_id: 12,
      text: null,
      rating: null,
      file_name: 'contrato.pdf',
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValueOnce({ reports: 1, removalId: 42 });
    announce.mockRejectedValueOnce(new Error('socket fora'));

    const removed = await moderationService.act(1, 8, 'remove-content', null);

    expect(repo.removeContentAndClose).toHaveBeenLastCalledWith(
      expect.objectContaining({ author: { id: 12, snapshot: 'Anexo: contrato.pdf' } }),
    );
    expect(announce).toHaveBeenCalledWith(55);
    expect(removed.result).toMatchObject({ removalId: 42, ownerStrikes: 1 });
  });
});

describe('decisões da fila: guardas e configuração (ADR 39, 41 e 44)', () => {
  it('remover imagem exige denúncia de imagem com o endereço guardado: sem endereço, ou alvo de outro tipo, é 422 e nada sai do ar', async () => {
    const notImage = [
      // Denúncia de foto sem o endereço da imagem (anterior ao ADR 39): não há o que remover.
      row({ id: 4, image_url: null }),
      // O que decide é o tipo do alvo, não a denúncia ter um endereço.
      row({ id: 4, target_type: 'user', image_url: MEDIA }),
      row({ id: 4, target_type: 'review', target_id: 21, image_url: null }),
    ];
    for (const report of notImage) {
      repo.findById.mockResolvedValueOnce(report);
      await expect(moderationService.act(1, 4, 'remove-image', null)).rejects.toMatchObject({
        statusCode: 422,
        code: 'not_an_image_report',
      });
    }

    expect(repo.findById).toHaveBeenCalledTimes(3);
    expect(repo.imageTarget).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(repo.removeImageAndClose).not.toHaveBeenCalled();
    expect(repo.closeGroup).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('remover conteúdo de denúncia que não é de texto não fecha o grupo nem procura o texto', async () => {
    for (const type of ['avatar', 'portfolio_item', 'service', 'user']) {
      repo.findById.mockResolvedValueOnce(row({ id: 4, target_type: type }));
      await expect(moderationService.act(1, 4, 'remove-content', null)).rejects.toMatchObject({
        statusCode: 422,
        code: 'not_a_content_report',
      });
    }
    expect(repo.textTarget).not.toHaveBeenCalled();
    expect(repo.removeContentAndClose).not.toHaveBeenCalled();
    expect(repo.closeGroup).not.toHaveBeenCalled();
  });

  it('denúncia já analisada (com ação ou dispensada) recusa qualquer decisão, sem tocar em nada', async () => {
    for (const status of ['actioned', 'dismissed']) {
      for (const action of ['dismiss', 'resolve', 'remove-image', 'remove-content'] as const) {
        repo.findById.mockResolvedValueOnce(row({ id: 4, status }));
        await expect(moderationService.act(1, 4, action, null)).rejects.toMatchObject({
          statusCode: 409,
          code: 'report_already_resolved',
        });
      }
    }
    expect(repo.closeGroup).not.toHaveBeenCalled();
    expect(repo.removeImageAndClose).not.toHaveBeenCalled();
    expect(repo.removeContentAndClose).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('denúncia inexistente é 404 com o código report_not_found', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(moderationService.act(1, 99, 'remove-image', null)).rejects.toMatchObject({
      statusCode: 404,
      code: 'report_not_found',
    });
    expect(repo.findById).toHaveBeenCalledWith(99);
    expect(repo.removeImageAndClose).not.toHaveBeenCalled();
  });

  it('o limite da revisão da conta e o prazo de contestação vêm da configuração, não de um número fixo', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    // Limite em 5: a terceira remoção ainda não abre a revisão.
    policy.mockResolvedValue({
      ...POLICY,
      appealWindowDays: 7,
      windowDays: 90,
      reviewThreshold: 5,
    });
    summary.mockResolvedValue({
      strikes: 3,
      imageStrikes: 3,
      windowDays: 90,
      reviewThreshold: 5,
      uploadsBlockedUntil: null,
    });

    const below = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.create).not.toHaveBeenCalled();
    expect(below.result).toMatchObject({ ownerStrikes: 3, accountReviewOpened: false });
    // Prazo de 7 dias a partir de agora (15/09 às 12:00 de Brasília).
    expect(notify).toHaveBeenLastCalledWith(
      9,
      expect.objectContaining({
        body: 'A moderação removeu a imagem por conteúdo ofensivo. A mesma imagem não pode ser enviada de novo. Se discordar, conteste pelo seu perfil até 22/09/2026 às 12:00.',
      }),
    );

    // Limite em 2: a segunda remoção já abre, e o texto diz a janela configurada.
    policy.mockResolvedValue({ ...POLICY, windowDays: 90, reviewThreshold: 2 });
    summary.mockResolvedValue({
      strikes: 2,
      imageStrikes: 2,
      windowDays: 90,
      reviewThreshold: 2,
      uploadsBlockedUntil: null,
    });

    const at = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({
      reporterId: 1,
      targetType: 'user',
      targetId: 9,
      imageUrl: null,
      reason: 'other',
      description: 'Reincidência: 2 remoções de conteúdo nos últimos 90 dias. Revise a conta.',
    });
    expect(at.result).toMatchObject({ ownerStrikes: 2, accountReviewOpened: true });
  });

  it('link externo de trabalho sem dono: não há arquivo para guardar nem apagar, nem a quem avisar', async () => {
    const external = 'https://i.pravatar.cc/150';
    repo.findById.mockResolvedValue(
      row({ target_type: 'portfolio_item', target_id: 3, image_url: external }),
    );
    repo.imageTarget.mockResolvedValue(undefined);
    repo.removeImageAndClose.mockResolvedValue({ cleared: 0, reports: 1, removalId: null });

    const { result, target } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.removeImageAndClose).toHaveBeenCalledWith({
      targetType: 'portfolio_item',
      targetId: 3,
      imageUrl: external,
      adminId: 1,
      note: null,
      url: external,
      print: null,
      reportId: 4,
      ownerId: null,
      reason: 'offensive',
    });
    expect(quarantine).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
    expect(removals.setQuarantineFile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'actioned',
      reports: 1,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
      removalId: null,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    expect(target).toEqual({ type: 'portfolio_item', id: 3, imageUrl: external });
  });

  it('texto que outra decisão tirou do ar no meio do caminho (sem registro de remoção): só fecha as denúncias, sem aviso nem ocorrência', async () => {
    repo.findById.mockResolvedValue(
      row({ id: 8, target_type: 'message', target_id: 55, image_url: null }),
    );
    // Na leitura o texto ainda estava no ar; na transação já não estava, e nada foi registrado.
    repo.textTarget.mockResolvedValue({
      owner_id: 12,
      text: 'Me paga no pix por fora',
      rating: null,
      file_name: null,
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValue({ reports: 1, removalId: null });

    const { result } = await moderationService.act(1, 8, 'remove-content', null);

    expect(summary).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'actioned',
      reports: 1,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
      removalId: null,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
  });

  it('avaliação removida por motivo fora da lista: o aviso fala em violar as regras, no fuso do autor', async () => {
    repo.findById.mockResolvedValue(
      row({
        id: 9,
        target_type: 'review',
        target_id: 21,
        image_url: null,
        reason: 'motivo_antigo',
      }),
    );
    repo.textTarget.mockResolvedValue({
      owner_id: 12,
      text: 'Péssimo',
      rating: 1,
      file_name: null,
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValue({ reports: 1, removalId: 41 });
    users.findById.mockResolvedValue({ timezone: 'America/Manaus' } as never);

    await moderationService.act(1, 9, 'remove-content', null);

    expect(repo.textTarget).toHaveBeenCalledWith('review', 21);
    expect(repo.removeContentAndClose).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'review', reportId: 9, reason: 'motivo_antigo' }),
    );
    expect(users.findById).toHaveBeenCalledWith(12);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(12, {
      type: 'content_removed',
      title: 'Sua avaliação foi removida',
      body: 'A moderação removeu a avaliação por violar as regras do Escambo. Se discordar, conteste pelo seu perfil até 29/09/2026 às 11:00.',
      data: { contentRemoved: 'review', reportId: 9, removalId: 41 },
    });
  });

  it('resolvidas sem data de análise (registro antigo) formam um grupo só e ficam depois das que têm data', async () => {
    const reviewed = new Date('2026-09-14T12:00:00Z');
    repo.listForModeration.mockResolvedValue([
      // Outro alvo, também sem data: é outro grupo, e entre os sem data vale a ordem do banco.
      row({ id: 4, target_id: 12, status: 'dismissed', reviewed_at: null }),
      row({ id: 3, status: 'dismissed', reviewed_at: null }),
      row({ id: 2, status: 'actioned', reviewed_at: reviewed, resolution_note: 'Removida.' }),
      row({ id: 1, status: 'dismissed', reviewed_at: null }),
    ]);

    const groups = await moderationService.listQueue('resolved');

    expect(groups.map((g) => [g.id, g.targetId, g.status, g.reports, g.reviewedAt])).toEqual([
      [2, 9, 'actioned', 1, '2026-09-14T12:00:00.000Z'],
      [4, 12, 'dismissed', 1, null],
      [3, 9, 'dismissed', 2, null],
    ]);
  });

  it('fila vazia: a lista sai vazia e nenhuma consulta de alvo recebe id', async () => {
    repo.listForModeration.mockResolvedValue([]);

    expect(await moderationService.listQueue('pending')).toEqual([]);
    expect(await moderationService.listQueue('resolved')).toEqual([]);

    for (const byIds of [
      repo.usersByIds,
      repo.portfolioByIds,
      repo.servicesByIds,
      repo.reviewsByIds,
      repo.messagesByIds,
    ]) {
      expect(byIds).toHaveBeenCalledTimes(2);
      expect(byIds).toHaveBeenNthCalledWith(1, []);
      expect(byIds).toHaveBeenNthCalledWith(2, []);
    }
  });

  it('o dono só vira link para o perfil com id e ULID; o nome pode faltar', async () => {
    repo.listForModeration.mockResolvedValue([
      row({ id: 3, target_type: 'service', target_id: 7, image_url: null }),
      row({ id: 2, target_type: 'service', target_id: 8, image_url: null }),
    ]);
    repo.servicesByIds.mockResolvedValue([
      info({ id: 7, owner_id: null, title: 'Sem dono' }),
      info({ id: 8, owner_id: 12, owner_ulid: '01OTHER', owner_name: null, title: 'Logo' }),
    ]);

    const groups = await moderationService.listQueue('pending');
    const byId = new Map(groups.map((g) => [g.id, g]));

    expect(byId.get(3)!.owner).toBeNull();
    expect(byId.get(2)!.owner).toEqual({ id: 12, ulid: '01OTHER', name: null });
  });

  it('acima do limite (a revisão anterior já foi fechada), a remoção seguinte abre outra revisão da conta', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    summary.mockResolvedValue({
      strikes: 4,
      imageStrikes: 4,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.hasOpenAccountReview).toHaveBeenCalledTimes(1);
    expect(repo.hasOpenAccountReview).toHaveBeenCalledWith(9);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({
      reporterId: 1,
      targetType: 'user',
      targetId: 9,
      imageUrl: null,
      reason: 'other',
      description: 'Reincidência: 4 remoções de conteúdo nos últimos 180 dias. Revise a conta.',
    });
    expect(result).toMatchObject({ ownerStrikes: 4, accountReviewOpened: true });
  });

  it('abaixo do limite nem consulta se há revisão aberta', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    summary.mockResolvedValue({
      strikes: 2,
      imageStrikes: 2,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.hasOpenAccountReview).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ownerStrikes: 2, accountReviewOpened: false });
  });

  it('imagem sem dono cujo arquivo já não estava no disco: o resultado diz que nenhum arquivo saiu', async () => {
    repo.findById.mockResolvedValue(row({ target_type: 'portfolio_item', target_id: 3 }));
    repo.imageTarget.mockResolvedValue(undefined);
    repo.removeImageAndClose.mockResolvedValue({ cleared: 0, reports: 1, removalId: null });
    deleteImage.mockResolvedValue(false);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(deleteImage).toHaveBeenCalledTimes(1);
    expect(deleteImage).toHaveBeenCalledWith(KEY);
    expect(quarantine).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'actioned',
      reports: 1,
      referencesCleared: 0,
      fileRemoved: false,
      // A impressão foi tirada do arquivo lido antes: o reenvio fica bloqueado mesmo assim.
      blocked: true,
      removalId: null,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
  });
});

describe('depois do commit: falha num passo não desfaz nem esconde a decisão gravada', () => {
  /** Mensagem do log de um passo que falhou depois da decisão. */
  const stepFailed = (step: string): string =>
    `moderação: ${step} falhou depois da decisão gravada`;
  const deadline = 'Se discordar, conteste pelo seu perfil até 29/09/2026 às 12:00.';

  let error: MockInstance<typeof logger.error>;
  beforeEach(() => {
    error = vi.spyOn(logger, 'error');
  });
  afterEach(() => error.mockRestore());

  it('o arquivo não pôde ir para a quarentena (pasta sem permissão): a remoção vale, o arquivo sai de vez, sem arquivo anotado, e o dono é avisado', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    quarantine.mockRejectedValueOnce(denied);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    // Sem a quarentena, o arquivo continuaria servido pela URL até o expurgo de órfãos.
    expect(deleteImage.mock.calls).toEqual([[KEY]]);
    expect(result).toMatchObject({ status: 'actioned', removalId: 31, fileRemoved: true });
    expect(removals.setQuarantineFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ body: expect.stringContaining(deadline) }),
    );
    expect(error).toHaveBeenCalledWith(
      { err: denied, reportId: 4, removalId: 31 },
      stepFailed('quarentena do arquivo'),
    );
    expect(sentry).toHaveBeenCalledWith(denied);
  });

  it('se nem a quarentena nem a exclusão de reserva tiram o arquivo, o resultado diz que ele não saiu e as duas falhas vão para o log', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    quarantine.mockRejectedValueOnce(denied);
    deleteImage.mockRejectedValueOnce(busy);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(result).toMatchObject({ status: 'actioned', removalId: 31, fileRemoved: false });
    expect(error.mock.calls.slice(0, 2)).toEqual([
      [{ err: denied, reportId: 4, removalId: 31 }, stepFailed('quarentena do arquivo')],
      [
        { err: busy, reportId: 4, removalId: 31 },
        stepFailed('remoção do arquivo (quarentena falhou)'),
      ],
    ]);
    expect(sentry).toHaveBeenCalledWith(busy);
    // A decisão segue: o dono é avisado mesmo assim.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('o arquivo foi para a quarentena mas não ficou anotado na remoção: ele é apagado (nada mais o acharia) e o resto segue', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    const boom = new Error('banco fora');
    removals.setQuarantineFile.mockRejectedValueOnce(boom);
    dropQuarantined.mockResolvedValueOnce(true);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(removals.setQuarantineFile).toHaveBeenCalledWith(31, '31.webp');
    // Apagado, e não devolvido à pasta pública: lá a imagem removida voltaria ao ar pela URL.
    expect(dropQuarantined).toHaveBeenCalledTimes(1);
    expect(dropQuarantined).toHaveBeenCalledWith('31.webp');
    expect(result).toMatchObject({ status: 'actioned', removalId: 31, fileRemoved: true });
    expect(summary).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { err: boom, reportId: 4, removalId: 31, file: '31.webp' },
      'moderação: arquivo da quarentena não anotado na remoção; vai ser apagado',
    );
    expect(sentry).toHaveBeenCalledWith(boom);
  });

  it('se nem o arquivo sem anotação pode ser apagado, vai para o log e a decisão ainda sai', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    removals.setQuarantineFile.mockRejectedValueOnce(new Error('banco fora'));
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    dropQuarantined.mockRejectedValueOnce(busy);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(result).toMatchObject({ status: 'actioned', removalId: 31 });
    expect(error).toHaveBeenLastCalledWith(
      { err: busy, reportId: 4, removalId: 31 },
      stepFailed('limpeza da quarentena'),
    );
  });

  it('sem dono, o arquivo que não pôde ser apagado não derruba a decisão', async () => {
    repo.findById.mockResolvedValue(row({ target_type: 'portfolio_item', target_id: 3 }));
    repo.imageTarget.mockResolvedValue(undefined);
    repo.removeImageAndClose.mockResolvedValue({ cleared: 0, reports: 1, removalId: null });
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    deleteImage.mockRejectedValueOnce(busy);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(result).toMatchObject({ status: 'actioned', removalId: null, fileRemoved: false });
    expect(error).toHaveBeenCalledWith(
      { err: busy, reportId: 4, removalId: null },
      stepFailed('remoção do arquivo'),
    );
  });

  it('a política de reincidência não pôde ser lida: sem reincidência nem revisão, e o aviso sai sem a data do prazo', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    const boom = new Error('banco fora');
    policy.mockRejectedValueOnce(boom);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(summary).not.toHaveBeenCalled();
    expect(repo.hasOpenAccountReview).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'actioned',
      fileRemoved: true,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    expect(notify).toHaveBeenCalledWith(9, {
      type: 'content_removed',
      title: 'Sua foto de perfil foi removida',
      body: 'A moderação removeu a imagem por conteúdo ofensivo. A mesma imagem não pode ser enviada de novo. Se discordar, conteste pelo seu perfil.',
      data: { contentRemoved: 'avatar', reportId: 4, removalId: 31 },
    });
    expect(error).toHaveBeenCalledWith(
      { err: boom, reportId: 4, removalId: 31 },
      stepFailed('política de reincidência'),
    );
  });

  it('a reincidência não pôde ser contada: o aviso sai com o prazo, sem bloqueio, e a conta não vai para revisão', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    summary.mockRejectedValueOnce(new Error('banco fora'));

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(repo.hasOpenAccountReview).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ownerStrikes: null, accountReviewOpened: false });
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        body: `A moderação removeu a imagem por conteúdo ofensivo. A mesma imagem não pode ser enviada de novo. ${deadline}`,
      }),
    );
    expect(error.mock.calls.map((c) => c[1])).toEqual([stepFailed('reincidência')]);
  });

  it('a revisão da conta não pôde ser aberta: a reincidência sai no resultado e o dono é avisado', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    summary.mockResolvedValue({
      strikes: 3,
      imageStrikes: 3,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: '2026-09-29T15:00:00.000Z',
    });
    repo.create.mockRejectedValueOnce(new Error('banco fora'));

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(result).toMatchObject({
      ownerStrikes: 3,
      uploadsBlockedUntil: '2026-09-29T15:00:00.000Z',
      accountReviewOpened: false,
    });
    expect(notify).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        body: expect.stringContaining('o envio de imagens fica bloqueado até 29/09/2026 às 12:00.'),
      }),
    );
    expect(error.mock.calls.map((c) => c[1])).toEqual([stepFailed('revisão da conta')]);
  });

  it('o aviso ao dono falhou: a decisão sai do mesmo jeito', async () => {
    repo.findById.mockResolvedValue(row({ id: 4 }));
    const boom = new Error('notificação fora');
    notify.mockRejectedValueOnce(boom);

    const { result } = await moderationService.act(1, 4, 'remove-image', null);

    expect(result).toMatchObject({ status: 'actioned', removalId: 31, ownerStrikes: 1 });
    expect(error).toHaveBeenCalledWith(
      { err: boom, reportId: 4, removalId: 31 },
      stepFailed('aviso ao dono'),
    );
  });

  it('mensagem: sem a política e sem o aviso, a remoção ainda sai e o chat ainda é atualizado', async () => {
    repo.findById.mockResolvedValue(
      row({ id: 8, target_type: 'message', target_id: 55, image_url: null, reason: 'spam' }),
    );
    repo.textTarget.mockResolvedValue({
      owner_id: 12,
      text: 'Compre já',
      rating: null,
      file_name: null,
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValue({ reports: 1, removalId: 40 });
    policy.mockRejectedValueOnce(new Error('banco fora'));
    notify.mockRejectedValueOnce(new Error('notificação fora'));

    const { result } = await moderationService.act(1, 8, 'remove-content', null);

    expect(result).toMatchObject({
      status: 'actioned',
      removalId: 40,
      ownerStrikes: null,
      accountReviewOpened: false,
    });
    expect(notify).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        body: 'A moderação removeu a mensagem por spam. Se discordar, conteste pelo seu perfil.',
      }),
    );
    expect(announce).toHaveBeenCalledWith(55);
    expect(error.mock.calls.map((c) => c[1])).toEqual([
      stepFailed('política de reincidência'),
      stepFailed('aviso ao autor'),
    ]);
  });

  it('avaliação: a revisão da conta que falha não impede o aviso ao autor', async () => {
    repo.findById.mockResolvedValue(
      row({ id: 9, target_type: 'review', target_id: 70, image_url: null, reason: 'offensive' }),
    );
    repo.textTarget.mockResolvedValue({
      owner_id: 12,
      text: 'Péssimo',
      rating: 1,
      file_name: null,
      removed_at: null,
    } as never);
    repo.removeContentAndClose.mockResolvedValue({ reports: 1, removalId: 41 });
    summary.mockResolvedValue({
      strikes: 3,
      imageStrikes: 0,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });
    repo.create.mockRejectedValueOnce(new Error('banco fora'));

    const { result } = await moderationService.act(1, 9, 'remove-content', null);

    expect(result).toMatchObject({ removalId: 41, ownerStrikes: 3, accountReviewOpened: false });
    expect(notify).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        body: `A moderação removeu a avaliação por conteúdo ofensivo. ${deadline}`,
      }),
    );
    expect(error.mock.calls.map((c) => c[1])).toEqual([stepFailed('revisão da conta')]);
  });
});
