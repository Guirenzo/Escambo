import { z } from 'zod';

export const createSavedSearchSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  query: z.string().max(255).nullable().optional(),
  filters: z.record(z.unknown()).nullable().optional(),
  alertEnabled: z.boolean().optional(),
});
export type CreateSavedSearchInput = z.infer<typeof createSavedSearchSchema>;

export const savedSearchIdSchema = z.object({ id: z.coerce.number().int().positive() });
