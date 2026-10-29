import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireVerifiedEmail } from '../../middlewares/require-verified-email';
import { asyncHandler } from '../../utils/async-handler';
import { cancelWithdrawal, listWithdrawals, requestWithdrawal } from './withdrawal.controller';

export const withdrawalRoutes = Router();

withdrawalRoutes.use(authenticate);
// Saque tira dinheiro da plataforma: exige e-mail confirmado (ADR 20, RF-006). Cancelar, não.
withdrawalRoutes.post('/', requireVerifiedEmail, asyncHandler(requestWithdrawal));
withdrawalRoutes.get('/', asyncHandler(listWithdrawals));
withdrawalRoutes.post('/:id/cancel', asyncHandler(cancelWithdrawal));
