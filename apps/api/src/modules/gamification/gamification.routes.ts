import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  getLeaderboard,
  getMyGamification,
  getMyHistory,
  getMyMissions,
} from './gamification.controller';

export const gamificationRoutes = Router();

gamificationRoutes.use(authenticate);
gamificationRoutes.get('/me', asyncHandler(getMyGamification));
gamificationRoutes.get('/me/history', asyncHandler(getMyHistory));
gamificationRoutes.get('/me/missions', asyncHandler(getMyMissions));
gamificationRoutes.get('/leaderboard', asyncHandler(getLeaderboard));
