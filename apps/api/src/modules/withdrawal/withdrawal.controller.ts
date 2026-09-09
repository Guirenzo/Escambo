import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import {
  createWithdrawalSchema,
  listWithdrawalsSchema,
  withdrawalIdParamSchema,
} from './withdrawal.schema';
import { withdrawalService } from './withdrawal.service';

export async function requestWithdrawal(req: Request, res: Response): Promise<void> {
  const input = createWithdrawalSchema.parse(req.body);
  const withdrawal = await withdrawalService.request(req.user!.uid, input);
  void auditService.log({
    userId: req.user!.uid,
    action: 'withdrawal_requested',
    entityType: 'withdrawal',
    entityId: withdrawal.id,
    newValue: { amount: withdrawal.amount, method: withdrawal.method },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.status(201).json(withdrawal);
}

export async function listWithdrawals(req: Request, res: Response): Promise<void> {
  const query = listWithdrawalsSchema.parse(req.query);
  res.json(await withdrawalService.listMine(req.user!.uid, query));
}

/** POST /api/withdrawals/:id/cancel — desiste de um saque ainda não processado (valor volta). */
export async function cancelWithdrawal(req: Request, res: Response): Promise<void> {
  const { id } = withdrawalIdParamSchema.parse(req.params);
  const withdrawal = await withdrawalService.cancelMine(id, req.user!.uid);
  void auditService.log({
    userId: req.user!.uid,
    action: 'withdrawal_cancelled',
    entityType: 'withdrawal',
    entityId: id,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.json(withdrawal);
}
