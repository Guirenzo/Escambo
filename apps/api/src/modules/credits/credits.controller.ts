import type { Request, Response } from 'express';
import { z } from 'zod';
import { creditsService } from './credits.service';

const listSchema = z.object({
  // Teto na página: sem ele, ?page=1e20 vira OFFSET 2e+21 e o MySQL recusa (500).
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/** GET /api/credits/transactions — extrato de créditos Escambo do usuário. */
export async function listCreditTransactions(req: Request, res: Response): Promise<void> {
  const { page, limit } = listSchema.parse(req.query);
  res.json(await creditsService.listTransactions(req.user!.uid, page, limit));
}
