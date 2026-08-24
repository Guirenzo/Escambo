import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  acceptContract,
  approveContract,
  cancelContract,
  createContract,
  deliverContract,
  getContract,
  listContracts,
  rejectContract,
  requestRevisionContract,
} from './contracts.controller';

export const contractsRoutes = Router();

// Toda contratação exige login.
contractsRoutes.use(authenticate);

contractsRoutes.post('/', asyncHandler(createContract));
contractsRoutes.get('/', asyncHandler(listContracts));
contractsRoutes.get('/:id', asyncHandler(getContract));

// Transições da máquina de estados (o service valida quem pode fazer o quê)
contractsRoutes.post('/:id/accept', asyncHandler(acceptContract));
contractsRoutes.post('/:id/reject', asyncHandler(rejectContract));
contractsRoutes.post('/:id/deliver', asyncHandler(deliverContract));
contractsRoutes.post('/:id/approve', asyncHandler(approveContract));
contractsRoutes.post('/:id/request-revision', asyncHandler(requestRevisionContract));
contractsRoutes.post('/:id/cancel', asyncHandler(cancelContract));
