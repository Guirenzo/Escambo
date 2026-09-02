import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { listCreditTransactions } from './credits.controller';

export const creditsRoutes = Router();

creditsRoutes.use(authenticate);
creditsRoutes.get('/transactions', asyncHandler(listCreditTransactions));
