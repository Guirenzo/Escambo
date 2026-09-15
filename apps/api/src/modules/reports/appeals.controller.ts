import type { Request, Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../utils/http-error';
import { adminRepository } from '../admin/admin.repository';
import { auditService } from '../audit/audit.service';
import { MEDIA_MIME } from '../media/media.paths';
import { APPEAL_MIN_CHARS, appealsService } from './appeals.service';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const appealBody = z.object({
  text: z
    .string()
    .trim()
    .min(APPEAL_MIN_CHARS, `Explique em pelo menos ${APPEAL_MIN_CHARS} caracteres`)
    .max(1000),
});
const appealsQuery = z.object({ status: z.enum(['pending', 'decided']).default('pending') });
const decisionParam = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(['uphold', 'overturn']),
});
const decisionBody = z.object({ note: z.string().trim().max(500).nullable().optional() });

/** GET /api/moderation/removals — as imagens removidas do usuário e a situação de reincidência. */
export async function myModeration(req: Request, res: Response): Promise<void> {
  res.json(await appealsService.mine(req.user!.uid));
}

/** POST /api/moderation/removals/:id/appeal — contesta uma remoção (uma vez, dentro do prazo). */
export async function appealRemoval(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const { text } = appealBody.parse(req.body);
  res.json(await appealsService.appeal(req.user!.uid, id, text));
}

/** GET /api/admin/appeals — contestações pendentes ou decididas (ADR 41). */
export async function listAppeals(req: Request, res: Response): Promise<void> {
  const { status } = appealsQuery.parse(req.query);
  res.json(await appealsService.listForAdmin(status));
}

/** GET /api/admin/appeals/:id/image — a imagem em quarentena, só para o admin decidir. */
export async function appealImage(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const abs = await appealsService.quarantineImage(id);
  const ext = abs.slice(abs.lastIndexOf('.') + 1);
  await new Promise<void>((resolve, reject) => {
    res.sendFile(
      abs,
      {
        dotfiles: 'deny',
        cacheControl: false,
        headers: {
          'Content-Type': MEDIA_MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
      (err) => {
        if (!err || res.headersSent) return resolve();
        reject(new HttpError(404, 'Imagem não disponível', 'removal_image_not_found'));
      },
    );
  });
}

/** POST /api/admin/appeals/:id/uphold|overturn — decide a contestação, com nota. */
export async function decideAppeal(req: Request, res: Response): Promise<void> {
  const { id, decision } = decisionParam.parse(req.params);
  const { note } = decisionBody.parse(req.body ?? {});
  const adminId = req.user!.uid;
  const result = await appealsService.decide(adminId, id, decision, note || null);
  const action = decision === 'uphold' ? 'appeal_upheld' : 'appeal_overturned';
  await adminRepository.recordAction(adminId, action, 'image_removal', id, note || null);
  void auditService.log({
    userId: adminId,
    action,
    entityType: 'image_removal',
    entityId: id,
    newValue: { note: note || null, ...result },
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  res.json(result);
}
