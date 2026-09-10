import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireAdmin } from '../../middlewares/require-admin';
import { asyncHandler } from '../../utils/async-handler';
import {
  banUser,
  completeDeletionRequest,
  completeWithdrawal,
  failWithdrawal,
  getMetrics,
  listOpenDisputes,
  listDeletionRequests,
  listWithdrawals,
  processWithdrawal,
  reactivateUser,
  rejectDeletionRequest,
  resolveDispute,
  suspendUser,
} from './admin.controller';

export const adminRoutes = Router();

adminRoutes.use(authenticate, requireAdmin);

adminRoutes.get('/metrics', asyncHandler(getMetrics));
adminRoutes.get('/disputes', asyncHandler(listOpenDisputes));
adminRoutes.post('/disputes/:id/resolve', asyncHandler(resolveDispute));
adminRoutes.post('/users/:ulid/suspend', asyncHandler(suspendUser));
adminRoutes.post('/users/:ulid/ban', asyncHandler(banUser));
adminRoutes.post('/users/:ulid/reactivate', asyncHandler(reactivateUser));
adminRoutes.get('/withdrawals', asyncHandler(listWithdrawals));
adminRoutes.post('/withdrawals/:id/process', asyncHandler(processWithdrawal));
adminRoutes.post('/withdrawals/:id/complete', asyncHandler(completeWithdrawal));
adminRoutes.post('/withdrawals/:id/fail', asyncHandler(failWithdrawal));
adminRoutes.get('/deletion-requests', asyncHandler(listDeletionRequests));
adminRoutes.post('/deletion-requests/:id/complete', asyncHandler(completeDeletionRequest));
adminRoutes.post('/deletion-requests/:id/reject', asyncHandler(rejectDeletionRequest));
