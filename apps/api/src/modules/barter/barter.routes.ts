import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireVerifiedEmail } from '../../middlewares/require-verified-email';
import { asyncHandler } from '../../utils/async-handler';
import {
  acceptBarter,
  cancelBarter,
  getBarter,
  listBarters,
  proposeBarter,
  rejectBarter,
} from './barter.controller';

export const barterRoutes = Router();

barterRoutes.use(authenticate);

// Propor e aceitar troca exigem e-mail confirmado (RF-006): aceitar gera os dois contratos e pode
// reservar a torna. Recusar e cancelar, não.
barterRoutes.post('/', requireVerifiedEmail, asyncHandler(proposeBarter));
barterRoutes.get('/', asyncHandler(listBarters));
barterRoutes.get('/:id', asyncHandler(getBarter));
barterRoutes.post('/:id/accept', requireVerifiedEmail, asyncHandler(acceptBarter));
barterRoutes.post('/:id/reject', asyncHandler(rejectBarter));
barterRoutes.post('/:id/cancel', asyncHandler(cancelBarter));
