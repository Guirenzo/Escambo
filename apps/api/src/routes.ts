import { Router } from 'express';
import { authRoutes } from './modules/auth/auth.routes';
import { contractsRoutes } from './modules/contracts/contracts.routes';
import { healthRoutes } from './modules/health/health.routes';
import { servicesRoutes } from './modules/services/services.routes';

/** Monta as rotas de cada módulo sob /api. */
export const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/services', servicesRoutes);
router.use('/contracts', contractsRoutes);
