import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  createSavedSearch,
  listSavedSearches,
  removeSavedSearch,
  updateSavedSearch,
} from './saved-searches.controller';

export const savedSearchesRoutes = Router();

savedSearchesRoutes.use(authenticate);
savedSearchesRoutes.post('/', asyncHandler(createSavedSearch));
savedSearchesRoutes.get('/', asyncHandler(listSavedSearches));
savedSearchesRoutes.patch('/:id', asyncHandler(updateSavedSearch));
savedSearchesRoutes.delete('/:id', asyncHandler(removeSavedSearch));
