import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { getWallet } from './wallet.controller';

export const walletRoutes = Router();

walletRoutes.use(authenticate);
walletRoutes.get('/', asyncHandler(getWallet));
