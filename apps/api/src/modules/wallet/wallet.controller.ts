import type { Request, Response } from 'express';
import { walletService } from './wallet.service';

/** GET /api/wallet — saldo disponível + retido em escrow do usuário logado. */
export async function getWallet(req: Request, res: Response): Promise<void> {
  res.json(await walletService.getBalance(req.user!.uid));
}
