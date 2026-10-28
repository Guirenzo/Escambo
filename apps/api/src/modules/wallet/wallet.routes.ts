import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireVerifiedEmail } from '../../middlewares/require-verified-email';
import { asyncHandler } from '../../utils/async-handler';
import {
  createDeposit,
  getDeposit,
  listDeposits,
  simulateDeposit,
} from '../payments/payments.controller';
import { getEarnings, getWallet, listWalletTransactions } from './wallet.controller';

export const walletRoutes = Router();

walletRoutes.use(authenticate);
walletRoutes.get('/', asyncHandler(getWallet));
walletRoutes.get('/transactions', asyncHandler(listWalletTransactions));
walletRoutes.get('/earnings', asyncHandler(getEarnings));
// Depósitos (cobrança PIX via gateway): criar, listar, consultar e — na demo — simular o pagamento.
// Criar e pagar exigem e-mail confirmado (RF-006); consultar, não.
walletRoutes.post('/deposits', requireVerifiedEmail, asyncHandler(createDeposit));
walletRoutes.get('/deposits', asyncHandler(listDeposits));
walletRoutes.get('/deposits/:id', asyncHandler(getDeposit));
walletRoutes.post('/deposits/:id/simulate', requireVerifiedEmail, asyncHandler(simulateDeposit));
