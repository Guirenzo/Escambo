import { z } from 'zod';

export const createBoostSchema = z.object({
  serviceId: z.number().int().positive(),
  planId: z.number().int().positive(),
});
export type CreateBoostInput = z.infer<typeof createBoostSchema>;
