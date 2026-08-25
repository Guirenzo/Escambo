import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { listWithdrawals, requestWithdrawal } from './withdrawal.controller';

export const withdrawalRoutes = Router();

withdrawalRoutes.use(authenticate);
withdrawalRoutes.post('/', asyncHandler(requestWithdrawal));
withdrawalRoutes.get('/', asyncHandler(listWithdrawals));
