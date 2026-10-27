import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireVerifiedEmail } from '../../middlewares/require-verified-email';
import { asyncHandler } from '../../utils/async-handler';
import { createBoost, listMyBoosts, listPlans } from './boosts.controller';

export const boostsRoutes = Router();

boostsRoutes.use(authenticate);
boostsRoutes.get('/plans', asyncHandler(listPlans));
boostsRoutes.get('/', asyncHandler(listMyBoosts));
// Impulsionar gasta créditos: exige e-mail confirmado (RF-006).
boostsRoutes.post('/', requireVerifiedEmail, asyncHandler(createBoost));
