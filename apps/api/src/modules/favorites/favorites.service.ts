import type { Favorite, FavoriteTargetType } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
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
    const ownerId = await favoritesRepository.targetOwner(input.targetType, input.targetId);
    if (ownerId === undefined) {
      throw input.targetType === 'service'
        ? new HttpError(404, 'Serviço não encontrado', 'service_not_found')
        : new HttpError(404, 'Freelancer não encontrado', 'freelancer_not_found');
    }
    if (ownerId === userId) {
      throw new HttpError(
        422,
        'Você não pode favoritar o próprio perfil nem os seus serviços',
        'cannot_favorite_self',
      );
    }
    await favoritesRepository.create(userId, input.targetType, input.targetId);
  },

  async remove(userId: number, targetType: string, targetId: number): Promise<void> {
    await favoritesRepository.remove(userId, targetType, targetId);
  },

  async list(userId: number): Promise<Favorite[]> {
    return (await favoritesRepository.listForUser(userId)).map(toFavorite);
  },
};
