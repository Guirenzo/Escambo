import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  createDeposit,
  getDeposit,
  listDeposits,
  simulateDeposit,
} from '../payments/payments.controller';
import { getWallet, listWalletTransactions } from './wallet.controller';

export const walletRoutes = Router();

walletRoutes.use(authenticate);
walletRoutes.get('/', asyncHandler(getWallet));
walletRoutes.get('/transactions', asyncHandler(listWalletTransactions));
// Depósitos (cobrança PIX via gateway): criar, listar, consultar e — na demo — simular o pagamento.
walletRoutes.post('/deposits', asyncHandler(createDeposit));
walletRoutes.get('/deposits', asyncHandler(listDeposits));
walletRoutes.get('/deposits/:id', asyncHandler(getDeposit));
walletRoutes.post('/deposits/:id/simulate', asyncHandler(simulateDeposit));
