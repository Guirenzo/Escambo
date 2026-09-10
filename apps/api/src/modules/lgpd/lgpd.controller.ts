import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { deletionRequestSchema, exportIdParamSchema, recordConsentSchema } from './lgpd.schema';
import { lgpdService } from './lgpd.service';

const ctx = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

export async function recordConsent(req: Request, res: Response): Promise<void> {
  const input = recordConsentSchema.parse(req.body);
  const consent = await lgpdService.recordConsent(req.user!.uid, input, ctx(req));
  void auditService.log({
    userId: req.user!.uid,
    action: 'lgpd_consent',
    entityType: 'consent',
    newValue: { type: input.type, version: input.version, accepted: input.accepted },
    ...ctx(req),
  });
  res.status(201).json(consent);
}

export async function getConsents(req: Request, res: Response): Promise<void> {
  res.json(await lgpdService.getConsents(req.user!.uid));
}

export async function requestDeletion(req: Request, res: Response): Promise<void> {
  const { reason } = deletionRequestSchema.parse(req.body);
  const request = await lgpdService.requestDeletion(req.user!.uid, reason ?? null);
  void auditService.log({
    userId: req.user!.uid,
    action: 'lgpd_deletion_requested',
    entityType: 'data_deletion_request',
    entityId: request.id,
    ...ctx(req),
  });
  res.status(201).json(request);
}

export async function getDeletionRequests(req: Request, res: Response): Promise<void> {
  res.json(await lgpdService.getDeletionRequests(req.user!.uid));
}

export async function requestExport(req: Request, res: Response): Promise<void> {
  const request = await lgpdService.requestExport(req.user!.uid);
  void auditService.log({
    userId: req.user!.uid,
    action: 'lgpd_export_requested',
    entityType: 'data_export_request',
    entityId: request.id,
    newValue: { status: request.status },
    ...ctx(req),
  });
  res.status(201).json(request);
}

export async function getExportRequests(req: Request, res: Response): Promise<void> {
  res.json(await lgpdService.getExportRequests(req.user!.uid));
}

/** GET /api/lgpd/export-requests/:id/download — o arquivo JSON, só para o titular. */
export async function downloadExport(req: Request, res: Response): Promise<void> {
  const { id } = exportIdParamSchema.parse(req.params);
  const { stream, fileName } = await lgpdService.openExport(id, req.user!.uid);
  void auditService.log({
    userId: req.user!.uid,
    action: 'lgpd_export_downloaded',
    entityType: 'data_export_request',
    entityId: id,
    ...ctx(req),
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  stream.pipe(res);
}
