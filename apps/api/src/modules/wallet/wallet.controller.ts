import type { Request, Response } from 'express';
import { z } from 'zod';
import { isCalendarDay } from './wallet.period';
import { walletService } from './wallet.service';

/** Dia do período do extrato: "AAAA-MM-DD" que existe no calendário. */
const day = z.string().refine(isCalendarDay, 'Informe um dia válido no formato AAAA-MM-DD');

const listSchema = z.object({
  // Teto na página: sem ele, ?page=1e20 vira OFFSET 2e+21 e o MySQL recusa (500).
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  from: day.optional(),
  to: day.optional(),
});

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
