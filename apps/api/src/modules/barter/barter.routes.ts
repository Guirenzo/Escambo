import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
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

barterRoutes.post('/', asyncHandler(proposeBarter));
barterRoutes.get('/', asyncHandler(listBarters));
barterRoutes.get('/:id', asyncHandler(getBarter));
barterRoutes.post('/:id/accept', asyncHandler(acceptBarter));
barterRoutes.post('/:id/reject', asyncHandler(rejectBarter));
barterRoutes.post('/:id/cancel', asyncHandler(cancelBarter));
