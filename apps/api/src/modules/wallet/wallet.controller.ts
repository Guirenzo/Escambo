import type { Request, Response } from 'express';
import { earningsQuerySchema } from './wallet.earnings';
import { earningsService } from './wallet.earnings.service';
import { ledgerQuerySchema as listSchema } from './wallet.period';
import { walletService } from './wallet.service';

/**
 * GET /api/wallet/earnings — ganhos do usuário logado por período (RF-082): liberações do escrow e
 * tornas recebidas, por dia, semana ou mês no fuso da conta; créditos à parte.
 */
export async function getEarnings(req: Request, res: Response): Promise<void> {
  res.json(await earningsService.report(req.user!.uid, earningsQuerySchema.parse(req.query)));
}

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
