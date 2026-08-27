import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { getCategories } from './categories.controller';

export const categoriesRoutes = Router();

categoriesRoutes.get('/', asyncHandler(getCategories));
