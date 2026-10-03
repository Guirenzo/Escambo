import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./reports.repository', () => ({
  reportsRepository: {
    create: vi.fn(),
    listForReporter: vi.fn(),
    imageTarget: vi.fn(),
    hasPending: vi.fn(),
  },
}));

import { reportsService } from './reports.service';
import { reportsRepository } from './reports.repository';

const repo = vi.mocked(reportsRepository);
const AVATAR = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';

beforeEach(() => {
  vi.resetAllMocks();
  repo.create.mockResolvedValue(15);
  repo.hasPending.mockResolvedValue(false);
});

describe('reportsService.create', () => {
  it('cria a denúncia com status pending, sem imagem quando o alvo não é imagem', async () => {
    const r = await reportsService.create(1, {
      targetType: 'service',
      targetId: 5,
      reason: 'fraud',
      description: ' parece golpe ',
    });
    expect(repo.imageTarget).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith({
      reporterId: 1,
      targetType: 'service',
      targetId: 5,
      imageUrl: null,
      reason: 'fraud',
      description: 'parece golpe',
    });
    expect(r).toMatchObject({ id: 15, status: 'pending', reason: 'fraud', imageUrl: null });
  });

  it('imagem (ADR 39): guarda o endereço lido do alvo, não o que o cliente mandou', async () => {
    repo.imageTarget.mockResolvedValue({ owner_id: 9, image_url: AVATAR, title: null } as never);
    const r = await reportsService.create(1, {
      targetType: 'avatar',
      targetId: 9,
      reason: 'offensive',
    });
    expect(repo.imageTarget).toHaveBeenCalledWith('avatar', 9);
    expect(repo.hasPending).toHaveBeenCalledWith(1, 'avatar', 9, AVATAR);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: AVATAR }));
    expect(r.imageUrl).toBe(AVATAR);
  });

  it('imagem: alvo inexistente 404, sem imagem 422, a própria 422 e repetida 409', async () => {
    repo.imageTarget.mockResolvedValueOnce(undefined);
    await expect(
      reportsService.create(1, { targetType: 'portfolio_item', targetId: 3, reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'report_target_not_found' });

    repo.imageTarget.mockResolvedValueOnce({
      owner_id: 9,
      image_url: null,
      title: 'Logo',
    } as never);
    await expect(
      reportsService.create(1, { targetType: 'portfolio_item', targetId: 3, reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'report_target_without_image' });

    repo.imageTarget.mockResolvedValueOnce({
      owner_id: 1,
      image_url: AVATAR,
      title: null,
    } as never);
    await expect(
      reportsService.create(1, { targetType: 'avatar', targetId: 1, reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'cannot_report_own_content' });

    repo.imageTarget.mockResolvedValueOnce({
      owner_id: 9,
      image_url: AVATAR,
      title: null,
    } as never);
    repo.hasPending.mockResolvedValueOnce(true);
    await expect(
      reportsService.create(1, { targetType: 'avatar', targetId: 9, reason: 'spam' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'already_reported' });

    expect(repo.create).not.toHaveBeenCalled();
  });

  it('a própria imagem é recusada sem nem consultar se há denúncia repetida; sem imagem também', async () => {
    repo.imageTarget.mockResolvedValueOnce({
      owner_id: 1,
      image_url: AVATAR,
      title: null,
    } as never);
    await expect(
      reportsService.create(1, { targetType: 'avatar', targetId: 1, reason: 'spam' }),
    ).rejects.toMatchObject({ code: 'cannot_report_own_content' });
    repo.imageTarget.mockResolvedValueOnce({ owner_id: 9, image_url: null, title: null } as never);
    await expect(
      reportsService.create(1, { targetType: 'avatar', targetId: 9, reason: 'spam' }),
    ).rejects.toMatchObject({ code: 'report_target_without_image' });

    expect(repo.hasPending).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('devolve a denúncia como foi gravada: o id do banco, o alvo, pendente e a hora de agora', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T15:00:00Z'));
    try {
      repo.imageTarget.mockResolvedValue({
        owner_id: 9,
        image_url: AVATAR,
        title: 'Logo',
      } as never);

      const r = await reportsService.create(7, {
        targetType: 'portfolio_item',
        targetId: 3,
        reason: 'offensive',
        description: null,
      });

      expect(repo.imageTarget).toHaveBeenCalledWith('portfolio_item', 3);
      expect(repo.hasPending).toHaveBeenCalledWith(7, 'portfolio_item', 3, AVATAR);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith({
        reporterId: 7,
        targetType: 'portfolio_item',
        targetId: 3,
        imageUrl: AVATAR,
        reason: 'offensive',
        description: null,
      });
      expect(r).toEqual({
        id: 15,
        targetType: 'portfolio_item',
        targetId: 3,
        reason: 'offensive',
        status: 'pending',
        imageUrl: AVATAR,
        createdAt: '2026-09-15T15:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('descrição ausente, nula ou só de espaços é gravada como nula; alvo de texto ou conta não lê imagem', async () => {
    const blanks: (string | null | undefined)[] = [undefined, null, '', '   \n '];
    for (const description of blanks) {
      await reportsService.create(7, {
        targetType: 'message',
        targetId: 55,
        reason: 'off_platform',
        ...(description === undefined ? {} : { description }),
      });
      expect(repo.create).toHaveBeenLastCalledWith({
        reporterId: 7,
        targetType: 'message',
        targetId: 55,
        imageUrl: null,
        reason: 'off_platform',
        description: null,
      });
    }
    for (const targetType of ['user', 'review'] as const) {
      const r = await reportsService.create(7, { targetType, targetId: 2, reason: 'other' });
      expect(r).toMatchObject({ targetType, targetId: 2, imageUrl: null, status: 'pending' });
    }

    expect(repo.create).toHaveBeenCalledTimes(6);
    expect(repo.imageTarget).not.toHaveBeenCalled();
    expect(repo.hasPending).not.toHaveBeenCalled();
  });
});

describe('reportsService.listMine', () => {
  it('devolve só as denúncias de quem pediu, sem a descrição nem a nota da moderação', async () => {
    repo.listForReporter.mockResolvedValue([
      {
        id: 15,
        reporter_id: 7,
        target_type: 'avatar',
        target_id: 9,
        image_url: AVATAR,
        reason: 'offensive',
        description: 'foto de outra pessoa',
        status: 'dismissed',
        reviewed_at: new Date('2026-09-16T10:00:00Z'),
        resolution_note: 'Não é ofensiva.',
        created_at: new Date('2026-09-15T10:00:00Z'),
      },
    ] as never);

    const mine = await reportsService.listMine(7);

    expect(repo.listForReporter).toHaveBeenCalledTimes(1);
    expect(repo.listForReporter).toHaveBeenCalledWith(7);
    expect(mine).toEqual([
      {
        id: 15,
        targetType: 'avatar',
        targetId: 9,
        reason: 'offensive',
        status: 'dismissed',
        imageUrl: AVATAR,
        createdAt: '2026-09-15T10:00:00.000Z',
      },
    ]);
  });

  it('quem nunca denunciou recebe a lista vazia', async () => {
    repo.listForReporter.mockResolvedValue([]);
    expect(await reportsService.listMine(7)).toEqual([]);
  });
});
