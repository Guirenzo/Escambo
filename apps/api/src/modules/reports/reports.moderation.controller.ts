import type { Request, Response } from 'express';
import { adminRepository } from '../admin/admin.repository';
import { auditService } from '../audit/audit.service';
import { moderationCsvFileName, moderationHistoryCsv } from './moderation.csv';
import { moderationHealthService } from './moderation.health';
import { moderationService } from './reports.moderation';
import {
  moderationHealthQuerySchema,
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

/** GET /api/admin/moderation/health — fila, tempo até decidir, acerto do detector e contestações (ADR 47). */
export async function getModerationHealth(req: Request, res: Response): Promise<void> {
  const { days } = moderationHealthQuerySchema.parse(req.query);
  res.json(await moderationHealthService.report(days));
}

/**
 * GET /api/admin/moderation/health/export.csv — a série por dia em CSV (ADR 55), em dias inteiros
 * de Brasília; a exportação fica nas ações do admin, como a do ledger.
 */
export async function exportModerationHealthCsv(req: Request, res: Response): Promise<void> {
  const { days } = moderationHealthQuerySchema.parse(req.query);
  const series = await moderationHealthService.history(days);
  const csv = moderationHistoryCsv(series);
  const fileName = moderationCsvFileName(series.history);
  const first = series.history[0]?.day ?? '';
  const last = series.history[series.history.length - 1]?.day ?? '';
  await adminRepository.recordAction(
    req.user!.uid,
    'moderation_health_exported',
    'moderation',
    null,
    `${days} dias · ${first} → ${last}`,
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csv);
}

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
