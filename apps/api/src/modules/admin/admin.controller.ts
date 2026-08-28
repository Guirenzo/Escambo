import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { disputeIdParamSchema, resolveDisputeSchema, userUlidSchema } from './admin.schema';
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

export const suspendUser = (req: Request, res: Response) => moderate(req, res, 'suspend');
export const banUser = (req: Request, res: Response) => moderate(req, res, 'ban');
export const reactivateUser = (req: Request, res: Response) => moderate(req, res, 'reactivate');
