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
    expect(list).toEqual([
      { id: 1, targetType: 'service', targetId: 5, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(repo.listForUser.mock.calls).toEqual([[1]]);
  });

  it('add grava uma única vez, só o favorito pedido, e não devolve nada', async () => {
    repo.create.mockResolvedValue(undefined);
    expect(await favoritesService.add(7, { targetType: 'service', targetId: 5 })).toBeUndefined();
    expect(repo.create.mock.calls).toEqual([[7, 'service', 5]]);
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('a falha do repositório não é engolida: favoritar, desfavoritar e listar rejeitam com o mesmo erro', async () => {
    const boom = new Error('ER_LOCK_DEADLOCK');
    repo.create.mockRejectedValueOnce(boom);
    repo.remove.mockRejectedValueOnce(boom);
    repo.listForUser.mockRejectedValueOnce(boom);

    await expect(favoritesService.add(7, { targetType: 'service', targetId: 5 })).rejects.toBe(
      boom,
    );
    await expect(favoritesService.remove(7, 'service', 5)).rejects.toBe(boom);
    await expect(favoritesService.list(7)).rejects.toBe(boom);
  });

  it('remove apaga o favorito de quem pediu, com o tipo e o alvo recebidos', async () => {
    repo.remove.mockResolvedValue(undefined);
    expect(await favoritesService.remove(7, 'service', 5)).toBeUndefined();
    expect(repo.remove.mock.calls).toEqual([[7, 'service', 5]]);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('list pede só os favoritos do usuário e devolve no formato da API, na ordem do repositório', async () => {
    repo.listForUser.mockResolvedValue([
      { id: 2, target_type: 'freelancer', target_id: 44, created_at: '2026-01-02T10:00:00Z' },
      { id: 1, target_type: 'service', target_id: 5, created_at: new Date('2026-01-01T00:00:00Z') },
    ] as unknown as FavoriteRow[]);

    expect(await favoritesService.list(7)).toEqual([
      { id: 2, targetType: 'freelancer', targetId: 44, createdAt: '2026-01-02T10:00:00.000Z' },
      { id: 1, targetType: 'service', targetId: 5, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(repo.listForUser.mock.calls).toEqual([[7]]);
  });

  it('sem favoritos, a lista é vazia', async () => {
    repo.listForUser.mockResolvedValue([]);
    expect(await favoritesService.list(7)).toEqual([]);
  });
});
