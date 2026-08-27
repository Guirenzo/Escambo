import type { Request, Response } from 'express';
import { categoriesService } from './categories.service';

/** GET /api/categories — árvore de categorias ativas (pública). */
export async function getCategories(_req: Request, res: Response): Promise<void> {
  res.json(await categoriesService.getTree());
}
