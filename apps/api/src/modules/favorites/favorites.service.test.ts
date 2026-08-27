import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./favorites.repository', () => ({
  favoritesRepository: { create: vi.fn(), remove: vi.fn(), listForUser: vi.fn() },
}));

import { favoritesService } from './favorites.service';
import { favoritesRepository, type FavoriteRow } from './favorites.repository';

const repo = vi.mocked(favoritesRepository);

beforeEach(() => vi.clearAllMocks());

describe('favoritesService', () => {
  it('add chama o repositório (idempotente)', async () => {
    repo.create.mockResolvedValue(undefined);
    await favoritesService.add(1, { targetType: 'freelancer', targetId: 9 });
    expect(repo.create).toHaveBeenCalledWith(1, 'freelancer', 9);
  });

  it('list mapeia as linhas', async () => {
    repo.listForUser.mockResolvedValue([
      { id: 1, target_type: 'service', target_id: 5, created_at: new Date('2026-01-01T00:00:00Z') },
    ] as unknown as FavoriteRow[]);
    const list = await favoritesService.list(1);
    expect(list[0]!.targetType).toBe('service');
    expect(list[0]!.targetId).toBe(5);
  });
});
