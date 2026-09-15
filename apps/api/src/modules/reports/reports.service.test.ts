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
  vi.clearAllMocks();
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
});
