import { Router } from 'express';
import { authRoutes } from './modules/auth/auth.routes';
import { healthRoutes } from './modules/health/health.routes';

/** Monta as rotas de cada módulo sob /api. */
export const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
