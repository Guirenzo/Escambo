/**
 * Rotas públicas do módulo de parâmetros da plataforma (camada de rota).
 * Os parâmetros são os números e interruptores que o admin muda pelo painel sem mexer no código:
 * taxa da plataforma, prazos (aprovação tácita, validade da proposta, carência), mínimos de
 * serviço e de saque, trocas ligadas e modo de manutenção. Ficam na tabela `platform_settings`.
 * Aqui só fica a leitura pública, sem login: o routes.ts monta este Router em `/api/settings`.
 * A leitura completa e a edição são do admin, em `/api/admin/settings` (admin.routes.ts e
 * admin.controller.ts), que chamam o mesmo settingsService.
 * O que chama: o controller (`settings.controller.ts`), que chama o service.
 */
import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { getPublicSettings } from './settings.controller';

export const settingsRoutes = Router();

// GET /api/settings/public: sem authenticate de propósito. O app precisa da taxa e dos prazos
// antes do login, e é por aqui que ele descobre que a plataforma está em manutenção (essa rota
// fica aberta no middleware de manutenção).
settingsRoutes.get('/public', asyncHandler(getPublicSettings));
