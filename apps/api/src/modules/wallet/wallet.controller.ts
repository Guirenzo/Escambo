import type { Request, Response } from 'express';
import { z } from 'zod';
import { walletService } from './wallet.service';

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/** GET /api/wallet/transactions — extrato de R$ do usuário logado. */
export async function listWalletTransactions(req: Request, res: Response): Promise<void> {
  const { page, limit } = listSchema.parse(req.query);
  res.json(await walletService.listTransactions(req.user!.uid, page, limit));
}

/** GET /api/wallet — saldo disponível + retido em escrow do usuário logado. */
export async function getWallet(req: Request, res: Response): Promise<void> {
  res.json(await walletService.getBalance(req.user!.uid));
}
