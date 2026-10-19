import { z } from 'zod';

export const dropoutIdSchema = z.object({ id: z.coerce.number().int().positive() });
export const dropoutAgreeBodySchema = z.object({}).strict().default({});
export const dropoutAppealBodySchema = z
  .object({
    text: z.string().trim().min(20, 'Explique em pelo menos 20 caracteres').max(1000),
  })
  .strict();
export const dropoutsAdminQuerySchema = z
  .object({ status: z.literal('appealed').default('appealed') })
  .strict();
export const dropoutDecisionParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(['excuse', 'uphold']),
});
export const dropoutDecisionBodySchema = z
  .object({ note: z.string().trim().min(10).max(500) })
  .strict();
export const dropoutUserParamsSchema = z.object({ ulid: z.string().length(26) });
