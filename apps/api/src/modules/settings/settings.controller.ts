/**
 * Controller público do módulo de parâmetros (camada de controller).
 * Só tem uma função: devolver ao app os parâmetros que qualquer um pode ver. Não recebe entrada,
 * então não tem schema para validar.
 * Quem chama: a rota GET /api/settings/public (`settings.routes.ts`).
 * O que chama: o settingsService.publicSettings (`settings.service.ts`), que lê `platform_settings`
 * com o cache curto. Os endpoints do admin (listar e mudar) ficam no admin.controller.ts.
 */
import type { Request, Response } from 'express';
import { settingsService } from './settings.service';

/** GET /api/settings/public — parâmetros que o app mostra sem login (taxa, prazos). */
export async function getPublicSettings(_req: Request, res: Response): Promise<void> {
  // O `_req` com sublinhado avisa que a requisição não é usada. A resposta é 200 com o objeto
  // PublicSettings (taxa, prazos, mínimos, trocas, manutenção e o gateway de pagamento).
  res.json(await settingsService.publicSettings());
}
