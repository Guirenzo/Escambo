import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { getDispute, listMyDisputes, openDispute } from './disputes.controller';

export const disputesRoutes = Router();

disputesRoutes.use(authenticate);
disputesRoutes.post('/', asyncHandler(openDispute));
disputesRoutes.get('/', asyncHandler(listMyDisputes));
disputesRoutes.get('/:id', asyncHandler(getDispute));
