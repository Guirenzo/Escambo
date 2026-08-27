import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { addFavorite, listFavorites, removeFavorite } from './favorites.controller';

export const favoritesRoutes = Router();

favoritesRoutes.use(authenticate);
favoritesRoutes.post('/', asyncHandler(addFavorite));
favoritesRoutes.get('/', asyncHandler(listFavorites));
favoritesRoutes.delete('/:targetType/:targetId', asyncHandler(removeFavorite));
