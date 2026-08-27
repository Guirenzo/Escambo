import { z } from 'zod';

export const createReportSchema = z.object({
  targetType: z.enum(['user', 'service', 'review', 'message']),
  targetId: z.number().int().positive(),
  reason: z.enum(['spam', 'fraud', 'offensive', 'off_platform', 'illegal', 'other']),
  description: z.string().max(2000).nullable().optional(),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;
