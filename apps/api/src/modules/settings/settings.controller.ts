import type { Request, Response } from 'express';
import { settingsService } from './settings.service';

/** GET /api/settings/public — parâmetros que o app mostra sem login (taxa, prazos). */
export async function getPublicSettings(_req: Request, res: Response): Promise<void> {
  res.json(await settingsService.publicSettings());
}
