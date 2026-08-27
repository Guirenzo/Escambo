import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./saved-searches.repository', () => ({
  savedSearchesRepository: { create: vi.fn(), listForUser: vi.fn(), remove: vi.fn() },
}));

import { savedSearchesService } from './saved-searches.service';
import { savedSearchesRepository, type SavedSearchRow } from './saved-searches.repository';

const repo = vi.mocked(savedSearchesRepository);

beforeEach(() => vi.clearAllMocks());

describe('savedSearchesService', () => {
  it('create serializa os filtros em JSON', async () => {
    repo.create.mockResolvedValue(3);
    const s = await savedSearchesService.create(1, {
      name: 'Devs em SC',
      query: 'react',
      filters: { categoryId: 10, isRemote: true },
      alertEnabled: true,
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, filters: JSON.stringify({ categoryId: 10, isRemote: true }), alertEnabled: true }),
    );
    expect(s.id).toBe(3);
    expect(s.alertEnabled).toBe(true);
  });

  it('list faz parse do JSON dos filtros', async () => {
    repo.listForUser.mockResolvedValue([
      { id: 1, name: null, query: 'x', filters: '{"categoryId":10}', alert_enabled: 0, created_at: new Date('2026-01-01T00:00:00Z') },
    ] as unknown as SavedSearchRow[]);
    const list = await savedSearchesService.list(1);
    expect(list[0]!.filters).toEqual({ categoryId: 10 });
    expect(list[0]!.alertEnabled).toBe(false);
  });

  it('remove lança 404 quando não é do usuário', async () => {
    repo.remove.mockResolvedValue(false);
    await expect(savedSearchesService.remove(1, 1)).rejects.toMatchObject({ statusCode: 404 });
  });
});
