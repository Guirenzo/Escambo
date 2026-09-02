import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { healthCheck, liveness } from './health.controller';

export const healthRoutes = Router();

healthRoutes.get('/', asyncHandler(healthCheck)); // readiness (com banco)
healthRoutes.get('/live', liveness); // liveness (sem banco)
