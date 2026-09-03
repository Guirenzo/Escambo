import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { createBoost, listMyBoosts, listPlans } from './boosts.controller';

export const boostsRoutes = Router();

boostsRoutes.use(authenticate);
boostsRoutes.get('/plans', asyncHandler(listPlans));
boostsRoutes.get('/', asyncHandler(listMyBoosts));
boostsRoutes.post('/', asyncHandler(createBoost));
