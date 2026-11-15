import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { mercadoPagoWebhook, webhook } from './payments.controller';

/** Rotas do gateway (sem sessão de usuário). Os depósitos do usuário ficam em /api/wallet. */
export const paymentsRoutes = Router();

paymentsRoutes.post('/webhook/mercadopago', asyncHandler(mercadoPagoWebhook));
paymentsRoutes.post('/webhook', asyncHandler(webhook));
