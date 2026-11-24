/**
 * Rotas do módulo health (camada de rotas): o routes.ts monta este router em /api/health.
 * Não pedem token nem passam pelo authenticate. Cada rota chama uma função do health.controller.
 * GET /api/health (readiness, com banco) e GET /api/health/live (liveness, sem banco).
 */
import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { healthCheck, liveness } from './health.controller';

export const healthRoutes = Router();

// O asyncHandler leva o erro da função assíncrona (banco fora) ao errorHandler; o liveness é
// síncrono e não precisa dele.
healthRoutes.get('/', asyncHandler(healthCheck)); // readiness (com banco)
healthRoutes.get('/live', liveness); // liveness (sem banco)
