import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  getConsents,
  getDeletionRequests,
  getExportRequests,
  recordConsent,
  requestDeletion,
  requestExport,
} from './lgpd.controller';

export const lgpdRoutes = Router();

lgpdRoutes.use(authenticate);

lgpdRoutes.post('/consents', asyncHandler(recordConsent));
lgpdRoutes.get('/consents', asyncHandler(getConsents));
lgpdRoutes.post('/deletion-requests', asyncHandler(requestDeletion));
lgpdRoutes.get('/deletion-requests', asyncHandler(getDeletionRequests));
lgpdRoutes.post('/export-requests', asyncHandler(requestExport));
lgpdRoutes.get('/export-requests', asyncHandler(getExportRequests));
