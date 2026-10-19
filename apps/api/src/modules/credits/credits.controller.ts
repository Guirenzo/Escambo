import type { Request, Response } from 'express';
import { ledgerQuerySchema } from '../wallet/wallet.period';
import { creditsService } from './credits.service';

/**
 * GET /api/credits/transactions — extrato de créditos Escambo do usuário. Como o de R$ (RF-047):
 * `from`/`to` filtram por dias no fuso da conta, os dois inclusivos, e `hasMore` diz se há outra
 * página.
 */
export async function listCreditTransactions(req: Request, res: Response): Promise<void> {
  const { page, limit, from, to } = ledgerQuerySchema.parse(req.query);
  res.json(await creditsService.listTransactions(req.user!.uid, page, limit, { from, to }));
}
