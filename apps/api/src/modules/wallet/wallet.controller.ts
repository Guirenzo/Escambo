import type { Request, Response } from 'express';
import { ledgerQuerySchema as listSchema } from './wallet.period';
import { walletService } from './wallet.service';

/**
 * GET /api/wallet/transactions — extrato de R$ do usuário logado. `from`/`to` (RF-047) filtram por
 * dias no fuso da conta, os dois inclusivos; a resposta diz se há outra página (`hasMore`).
 */
export async function listWalletTransactions(req: Request, res: Response): Promise<void> {
  const { page, limit, from, to } = listSchema.parse(req.query);
  res.json(await walletService.listTransactions(req.user!.uid, page, limit, { from, to }));
}

/** GET /api/wallet — saldo disponível + retido em escrow do usuário logado. */
export async function getWallet(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  res.json(
    await (user.status === 'suspended'
      ? walletService.getBalance(user.uid, { readOnly: true })
      : walletService.getBalance(user.uid)),
  );
}
