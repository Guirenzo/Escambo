import type { Request, Response } from 'express';
import { createWithdrawalSchema, listWithdrawalsSchema } from './withdrawal.schema';
import { withdrawalService } from './withdrawal.service';

export async function requestWithdrawal(req: Request, res: Response): Promise<void> {
  const input = createWithdrawalSchema.parse(req.body);
  res.status(201).json(await withdrawalService.request(req.user!.uid, input));
}

export async function listWithdrawals(req: Request, res: Response): Promise<void> {
  const query = listWithdrawalsSchema.parse(req.query);
  res.json(await withdrawalService.listMine(req.user!.uid, query));
}
