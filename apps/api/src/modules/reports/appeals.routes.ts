import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { appealRemoval, myModeration } from './appeals.controller';

/** Moderação vista pelo dono (ADR 41): imagens removidas, reincidência e contestação. */
export const moderationRoutes = Router();

moderationRoutes.use(authenticate);
moderationRoutes.get('/removals', asyncHandler(myModeration));
moderationRoutes.post('/removals/:id/appeal', asyncHandler(appealRemoval));
