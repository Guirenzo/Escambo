import { Router } from 'express';
import { authRoutes } from './modules/auth/auth.routes';
import { barterRoutes } from './modules/barter/barter.routes';
import { categoriesRoutes } from './modules/categories/categories.routes';
import { contractsRoutes } from './modules/contracts/contracts.routes';
import { gamificationRoutes } from './modules/gamification/gamification.routes';
import { healthRoutes } from './modules/health/health.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { profilesRoutes } from './modules/profiles/profiles.routes';
import { reviewsRoutes } from './modules/reviews/reviews.routes';
import { servicesRoutes } from './modules/services/services.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { withdrawalRoutes } from './modules/withdrawal/withdrawal.routes';

/** Monta as rotas de cada módulo sob /api. */
export const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/categories', categoriesRoutes);
router.use('/profiles', profilesRoutes);
router.use('/services', servicesRoutes);
router.use('/contracts', contractsRoutes);
router.use('/wallet', walletRoutes);
router.use('/reviews', reviewsRoutes);
router.use('/gamification', gamificationRoutes);
router.use('/barters', barterRoutes);
router.use('/withdrawals', withdrawalRoutes);
router.use('/notifications', notificationsRoutes);
