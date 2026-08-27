import type { Favorite, FavoriteTargetType } from '@escambo/types';
import { favoritesRepository, type FavoriteRow } from './favorites.repository';
import type { CreateFavoriteInput } from './favorites.schema';

function toFavorite(r: FavoriteRow): Favorite {
  return {
    id: r.id,
    targetType: r.target_type as FavoriteTargetType,
    targetId: r.target_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const favoritesService = {
  async add(userId: number, input: CreateFavoriteInput): Promise<void> {
    await favoritesRepository.create(userId, input.targetType, input.targetId);
  },

  async remove(userId: number, targetType: string, targetId: number): Promise<void> {
    await favoritesRepository.remove(userId, targetType, targetId);
  },

  async list(userId: number): Promise<Favorite[]> {
    return (await favoritesRepository.listForUser(userId)).map(toFavorite);
  },
};
