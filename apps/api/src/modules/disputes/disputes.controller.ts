import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { disputeIdSchema, openDisputeSchema } from './disputes.schema';
import { disputesService } from './disputes.service';

export async function openDispute(req: Request, res: Response): Promise<void> {
  const input = openDisputeSchema.parse(req.body);
  const dispute = await disputesService.open(req.user!.uid, input);
  void auditService.log({
    userId: req.user!.uid,
    action: 'dispute_opened',
    entityType: 'dispute',
    entityId: dispute.id,
    newValue: { contractId: dispute.contractId, reason: dispute.reason },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.status(201).json(dispute);
}

export async function listMyDisputes(req: Request, res: Response): Promise<void> {
  res.json(await disputesService.listMine(req.user!.uid));
}

export async function getDispute(req: Request, res: Response): Promise<void> {
  const { id } = disputeIdSchema.parse(req.params);
  res.json(await disputesService.getById(id, req.user!.uid));
}
