import { z } from 'zod';

export const REPORT_TARGETS = [
  'user',
  'service',
  'review',
  'message',
  'avatar',
  'portfolio_item',
] as const;

/** Alvos que são imagem (ADR 39): a moderação pode remover a imagem e impedir que ela volte. */
export const IMAGE_TARGETS = ['avatar', 'portfolio_item'] as const;
export type ImageTarget = (typeof IMAGE_TARGETS)[number];
export const isImageTarget = (t: string): t is ImageTarget =>
  (IMAGE_TARGETS as readonly string[]).includes(t);

/** Alvos de texto (ADR 44): a moderação pode tirar a avaliação ou a mensagem do ar. */
export const TEXT_TARGETS = ['review', 'message'] as const;
export type TextTarget = (typeof TEXT_TARGETS)[number];
export const isTextTarget = (t: string): t is TextTarget =>
  (TEXT_TARGETS as readonly string[]).includes(t);

export const REPORT_REASONS = [
  'spam',
  'fraud',
  'offensive',
  'off_platform',
  'illegal',
  'other',
] as const;

export const createReportSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.number().int().positive(),
  reason: z.enum(REPORT_REASONS),
  description: z.string().max(2000).nullable().optional(),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

/** Fila de moderação: pendentes (a analisar) ou resolvidas (com ação ou dispensadas). */
export const moderationQuerySchema = z.object({
  status: z.enum(['pending', 'resolved']).default('pending'),
});

export const reportActionParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  action: z.enum(['dismiss', 'resolve', 'remove-image', 'remove-content']),
});
export type ReportAction = z.infer<typeof reportActionParamSchema>['action'];

export const reportActionBodySchema = z.object({
  note: z.string().trim().max(500).nullable().optional(),
});
