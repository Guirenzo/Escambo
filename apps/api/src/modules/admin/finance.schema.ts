import { z } from 'zod';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');

export const financeQuerySchema = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  granularity: z.enum(['day', 'month']).default('month'),
});
export type FinanceQueryInput = z.infer<typeof financeQuerySchema>;
