import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import {
  dropoutAgreeBodySchema,
  dropoutAppealBodySchema,
  dropoutDecisionBodySchema,
  dropoutDecisionParamsSchema,
  dropoutIdSchema,
  dropoutsAdminQuerySchema,
  dropoutUserParamsSchema,
} from './dropouts.schema';
import { dropoutsService } from './dropouts.service';

export async function agreeDropout(req: Request, res: Response): Promise<void> {
  const { id } = dropoutIdSchema.parse(req.params);
  dropoutAgreeBodySchema.parse(req.body);
  const dropout = await dropoutsService.agree(id, req.user!.uid);
  void auditService.log({
    userId: req.user!.uid,
    action: 'dropout_agreed',
    entityType: 'contract',
    entityId: id,
    newValue: { agreedAt: dropout.agreedAt },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.json(dropout);
}

export async function myDropouts(req: Request, res: Response): Promise<void> {
  res.json(await dropoutsService.myDropouts(req.user!.uid));
}

export async function appealDropout(req: Request, res: Response): Promise<void> {
  const { id } = dropoutIdSchema.parse(req.params);
  const { text } = dropoutAppealBodySchema.parse(req.body);
  res.json(await dropoutsService.appeal(req.user!.uid, id, text));
}

export async function listDropoutAppeals(req: Request, res: Response): Promise<void> {
  dropoutsAdminQuerySchema.parse(req.query);
  res.json(await dropoutsService.listAppealed());
}

export async function listUserDropouts(req: Request, res: Response): Promise<void> {
  const { ulid } = dropoutUserParamsSchema.parse(req.params);
  res.json(await dropoutsService.listForUser(ulid));
}

export async function decideDropout(req: Request, res: Response): Promise<void> {
  const { id, decision } = dropoutDecisionParamsSchema.parse(req.params);
  const { note } = dropoutDecisionBodySchema.parse(req.body);
  // admin_actions é gravado na transação da decisão. A nota não entra no histórico do contrato.
  res.json(await dropoutsService.decide(req.user!.uid, id, decision, note, req.ip ?? null));
}
