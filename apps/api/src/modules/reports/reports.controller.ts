import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { createReportSchema } from './reports.schema';
import { reportsService } from './reports.service';

export async function createReport(req: Request, res: Response): Promise<void> {
  const input = createReportSchema.parse(req.body);
  const report = await reportsService.create(req.user!.uid, input);
  void auditService.log({
    userId: req.user!.uid,
    action: 'content_reported',
    entityType: input.targetType,
    entityId: input.targetId,
    newValue: { reason: input.reason },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.status(201).json(report);
}

export async function listMyReports(req: Request, res: Response): Promise<void> {
  res.json(await reportsService.listMine(req.user!.uid));
}
