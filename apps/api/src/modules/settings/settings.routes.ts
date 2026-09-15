import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { getPublicSettings } from './settings.controller';

export const settingsRoutes = Router();

settingsRoutes.get('/public', asyncHandler(getPublicSettings));
