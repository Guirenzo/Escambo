import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  acceptContract,
  approveContract,
  approveMilestone,
  cancelContract,
  createContract,
  deliverContract,
  deliverMilestone,
  getContract,
  listContracts,
  rejectContract,
  requestMilestoneRevision,
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

// Escrow por marcos (RN-069): entrega, aprovação (libera só aquele marco) e revisão por marco.
contractsRoutes.post('/:id/milestones/:milestoneId/deliver', asyncHandler(deliverMilestone));
contractsRoutes.post('/:id/milestones/:milestoneId/approve', asyncHandler(approveMilestone));
contractsRoutes.post(
  '/:id/milestones/:milestoneId/request-revision',
  asyncHandler(requestMilestoneRevision),
);
