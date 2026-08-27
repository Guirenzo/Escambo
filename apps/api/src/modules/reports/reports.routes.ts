import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { createReport, listMyReports } from './reports.controller';

export const reportsRoutes = Router();

reportsRoutes.use(authenticate);
reportsRoutes.post('/', asyncHandler(createReport));
reportsRoutes.get('/', asyncHandler(listMyReports));
