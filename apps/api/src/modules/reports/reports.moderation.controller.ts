import type { Request, Response } from 'express';
import { adminRepository } from '../admin/admin.repository';
import { auditService } from '../audit/audit.service';
import { moderationService } from './reports.moderation';
import {
  moderationQuerySchema,
  reportActionBodySchema,
  reportActionParamSchema,
} from './reports.schema';

const RECORDED_AS = {
  dismiss: 'reports_dismissed',
  resolve: 'reports_resolved',
  'remove-image': 'image_removed',
  'remove-content': 'content_removed',
} as const;

/** GET /api/admin/reports — fila de moderação agrupada por alvo e imagem (ADR 39). */
export async function listReports(req: Request, res: Response): Promise<void> {
  const { status } = moderationQuerySchema.parse(req.query);
  res.json(await moderationService.listQueue(status));
}

/**
 * POST /api/admin/reports/:id/:action — dispensa, resolve ou remove a imagem, para o grupo todo da
 * denúncia. A decisão fica nas ações do admin (com a nota) e na trilha de auditoria.
 */
export async function actOnReport(req: Request, res: Response): Promise<void> {
  const { id, action } = reportActionParamSchema.parse(req.params);
  const { note } = reportActionBodySchema.parse(req.body ?? {});
  const adminId = req.user!.uid;
  const { result, target } = await moderationService.act(adminId, id, action, note || null);
  await adminRepository.recordAction(
    adminId,
    RECORDED_AS[action],
    target.type,
    target.id,
    note || null,
  );
  void auditService.log({
    userId: adminId,
    action: RECORDED_AS[action],
    entityType: target.type,
    entityId: target.id,
    newValue: { reportId: id, imageUrl: target.imageUrl, note: note || null, ...result },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.json(result);
}
