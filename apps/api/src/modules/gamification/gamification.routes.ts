import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { getLeaderboard, getMyGamification, getMyHistory } from './gamification.controller';

export const gamificationRoutes = Router();

gamificationRoutes.use(authenticate);
gamificationRoutes.get('/me', asyncHandler(getMyGamification));
gamificationRoutes.get('/me/history', asyncHandler(getMyHistory));
gamificationRoutes.get('/leaderboard', asyncHandler(getLeaderboard));
