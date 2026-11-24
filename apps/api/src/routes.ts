/**
 * Roteador principal da API (camada de rotas): liga o router de cada módulo num caminho. O app.ts
 * monta este router em /api, então "/contracts" aqui vira /api/contracts.
 *
 * Cada módulo (modules/<nome>/<nome>.routes.ts) declara as próprias rotas e os middlewares delas
 * (authenticate, requireAdmin, requireVerifiedEmail). Cada rota chama o controller do módulo, que
 * chama o service, que chama o repository, que fala com o MySQL pelo pool do config/db.ts.
 * Exemplo: POST /api/contracts entra no contractsRoutes, passa pelo authenticate e pelo
 * requireVerifiedEmail e chega no createContract do controller de contratações.
 */
import { Router } from 'express';
import { adminRoutes } from './modules/admin/admin.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { barterRoutes } from './modules/barter/barter.routes';
import { boostsRoutes } from './modules/boosts/boosts.routes';
import { categoriesRoutes } from './modules/categories/categories.routes';
import { contractsRoutes } from './modules/contracts/contracts.routes';
import { creditsRoutes } from './modules/credits/credits.routes';
import { disputesRoutes } from './modules/disputes/disputes.routes';
import { favoritesRoutes } from './modules/favorites/favorites.routes';
import { gamificationRoutes } from './modules/gamification/gamification.routes';
import { healthRoutes } from './modules/health/health.routes';
import { lgpdRoutes } from './modules/lgpd/lgpd.routes';
import { messagingRoutes } from './modules/messaging/messaging.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { profilesRoutes } from './modules/profiles/profiles.routes';
import { moderationRoutes } from './modules/reports/appeals.routes';
import { reportsRoutes } from './modules/reports/reports.routes';
import { reviewsRoutes } from './modules/reviews/reviews.routes';
import { savedSearchesRoutes } from './modules/saved-searches/saved-searches.routes';
import { servicesRoutes } from './modules/services/services.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { withdrawalRoutes } from './modules/withdrawal/withdrawal.routes';
import { settingsRoutes } from './modules/settings/settings.routes';
import { mediaRoutes } from './modules/media/media.routes';
import { supportRoutes, adminSupportRoutes } from './modules/support/support.routes';
import { clientErrorsRoutes } from './modules/client-errors/client-errors.routes';

/** Monta as rotas de cada módulo sob /api. */
export const router = Router();

// O health não pede token (o orquestrador consulta sem login) e o auth tem as rotas que geram o
// token (login, cadastro, renovação). Quem exige login é decidido no routes.ts de cada módulo.
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/categories', categoriesRoutes);
router.use('/profiles', profilesRoutes);
router.use('/services', servicesRoutes);
router.use('/contracts', contractsRoutes);
router.use('/wallet', walletRoutes);
router.use('/credits', creditsRoutes);
router.use('/boosts', boostsRoutes);
router.use('/reviews', reviewsRoutes);
router.use('/gamification', gamificationRoutes);
router.use('/barters', barterRoutes);
router.use('/withdrawals', withdrawalRoutes);
router.use('/payments', paymentsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/messaging', messagingRoutes);
router.use('/lgpd', lgpdRoutes);
router.use('/favorites', favoritesRoutes);
router.use('/saved-searches', savedSearchesRoutes);
router.use('/reports', reportsRoutes);
router.use('/moderation', moderationRoutes);
router.use('/disputes', disputesRoutes);
// Suporte tem dois routers: o do titular (os próprios chamados) e o da equipe, em /admin, que
// exige authenticate e requireAdmin (support.routes.ts).
router.use('/support/tickets', supportRoutes);
router.use('/admin/support/tickets', adminSupportRoutes);
router.use('/admin', adminRoutes);
router.use('/settings', settingsRoutes);
router.use('/media', mediaRoutes);
router.use('/client-errors', clientErrorsRoutes);
