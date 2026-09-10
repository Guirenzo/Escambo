import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { lgpdService } from '../lgpd/lgpd.service';
import { mailService } from '../mail/mail.service';
import { withdrawalService } from '../withdrawal/withdrawal.service';
import {
  adminDeletionsQuerySchema,
  adminEmailsQuerySchema,
  adminWithdrawalsQuerySchema,
  completeWithdrawalSchema,
  deletionIdParamSchema,
  disputeIdParamSchema,
  failWithdrawalSchema,
  rejectDeletionSchema,
  resolveDisputeSchema,
  userUlidSchema,
  withdrawalIdParamSchema,
} from './admin.schema';
import { adminService } from './admin.service';

const audit = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

export async function getMetrics(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.getMetrics());
}

export async function listOpenDisputes(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.listOpenDisputes());
}

export async function resolveDispute(req: Request, res: Response): Promise<void> {
  const { id } = disputeIdParamSchema.parse(req.params);
  const input = resolveDisputeSchema.parse(req.body);
  const dispute = await adminService.resolveDispute(req.user!.uid, id, input);
  void auditService.log({
    userId: req.user!.uid,
    action: 'dispute_resolved',
    entityType: 'dispute',
    entityId: id,
    newValue: { resolution: input.resolution, refundPercentage: input.refundPercentage ?? null },
    ...audit(req),
  });
  res.json(dispute);
}

async function moderate(req: Request, res: Response, action: 'suspend' | 'ban' | 'reactivate'): Promise<void> {
  const { ulid } = userUlidSchema.parse(req.params);
  await adminService.moderateUser(req.user!.uid, ulid, action);
  void auditService.log({
    userId: req.user!.uid,
    action: `user_${action}`,
    entityType: 'user',
    newValue: { ulid },
    ...audit(req),
  });
  res.status(204).send();
}

// ---------- Saques (processamento manual pelo admin) ----------

export async function listWithdrawals(req: Request, res: Response): Promise<void> {
  const { status } = adminWithdrawalsQuerySchema.parse(req.query);
  res.json(await withdrawalService.listForAdmin(status));
}

export async function processWithdrawal(req: Request, res: Response): Promise<void> {
  const { id } = withdrawalIdParamSchema.parse(req.params);
  const w = await withdrawalService.process(req.user!.uid, id);
  void auditService.log({
    userId: req.user!.uid,
    action: 'withdrawal_processing',
    entityType: 'withdrawal',
    entityId: id,
    ...audit(req),
  });
  res.json(w);
}

export async function completeWithdrawal(req: Request, res: Response): Promise<void> {
  const { id } = withdrawalIdParamSchema.parse(req.params);
  const input = completeWithdrawalSchema.parse(req.body ?? {});
  const w = await withdrawalService.complete(req.user!.uid, id, input.gatewayRef ?? null);
  void auditService.log({
    userId: req.user!.uid,
    action: 'withdrawal_completed',
    entityType: 'withdrawal',
    entityId: id,
    newValue: { gatewayRef: input.gatewayRef ?? null },
    ...audit(req),
  });
  res.json(w);
}

export async function failWithdrawal(req: Request, res: Response): Promise<void> {
  const { id } = withdrawalIdParamSchema.parse(req.params);
  const input = failWithdrawalSchema.parse(req.body ?? {});
  const w = await withdrawalService.fail(req.user!.uid, id, input.reason ?? null);
  void auditService.log({
    userId: req.user!.uid,
    action: 'withdrawal_failed',
    entityType: 'withdrawal',
    entityId: id,
    newValue: { reason: input.reason ?? null },
    ...audit(req),
  });
  res.json(w);
}

/** Caixa de saída de e-mails (no provedor simulado é a própria entrega). */
export async function listEmails(req: Request, res: Response): Promise<void> {
  const { limit, userId } = adminEmailsQuerySchema.parse(req.query);
  res.json(await mailService.listRecent(limit, userId ?? null));
}

// ---------- LGPD: pedidos de exclusão de conta ----------

export async function listDeletionRequests(req: Request, res: Response): Promise<void> {
  const { status } = adminDeletionsQuerySchema.parse(req.query);
  res.json(await lgpdService.listDeletionRequestsForAdmin(status));
}

export async function completeDeletionRequest(req: Request, res: Response): Promise<void> {
  const { id } = deletionIdParamSchema.parse(req.params);
  const r = await lgpdService.completeDeletion(req.user!.uid, id);
  void auditService.log({
    userId: req.user!.uid,
    action: 'lgpd_deletion_completed',
    entityType: 'data_deletion_request',
    entityId: id,
    ...audit(req),
  });
  res.json(r);
}

export async function rejectDeletionRequest(req: Request, res: Response): Promise<void> {
  const { id } = deletionIdParamSchema.parse(req.params);
  const { note } = rejectDeletionSchema.parse(req.body ?? {});
  const r = await lgpdService.rejectDeletion(req.user!.uid, id, note);
  void auditService.log({
    userId: req.user!.uid,
    action: 'lgpd_deletion_rejected',
    entityType: 'data_deletion_request',
    entityId: id,
    newValue: { note },
    ...audit(req),
  });
  res.json(r);
}

export const suspendUser = (req: Request, res: Response) => moderate(req, res, 'suspend');
export const banUser = (req: Request, res: Response) => moderate(req, res, 'ban');
export const reactivateUser = (req: Request, res: Response) => moderate(req, res, 'reactivate');
