import type { Request, Response } from 'express';
import { createFavoriteSchema, favoriteParamsSchema } from './favorites.schema';
import { favoritesService } from './favorites.service';

export async function addFavorite(req: Request, res: Response): Promise<void> {
  const input = createFavoriteSchema.parse(req.body);
  await favoritesService.add(req.user!.uid, input);
  res.status(201).json({ ok: true });
}

export async function removeFavorite(req: Request, res: Response): Promise<void> {
  const { targetType, targetId } = favoriteParamsSchema.parse(req.params);
  await favoritesService.remove(req.user!.uid, targetType, targetId);
  res.status(204).send();
}

export async function listFavorites(req: Request, res: Response): Promise<void> {
  res.json(await favoritesService.list(req.user!.uid));
}
