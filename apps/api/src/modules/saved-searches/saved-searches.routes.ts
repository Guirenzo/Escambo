import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { createSavedSearch, listSavedSearches, removeSavedSearch } from './saved-searches.controller';

export const savedSearchesRoutes = Router();

savedSearchesRoutes.use(authenticate);
savedSearchesRoutes.post('/', asyncHandler(createSavedSearch));
savedSearchesRoutes.get('/', asyncHandler(listSavedSearches));
savedSearchesRoutes.delete('/:id', asyncHandler(removeSavedSearch));
