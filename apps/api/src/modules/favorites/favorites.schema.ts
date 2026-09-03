import { z } from 'zod';

export const createFavoriteSchema = z.object({
  targetType: z.enum(['service', 'freelancer']),
  targetId: z.number().int().positive(),
});
export type CreateFavoriteInput = z.infer<typeof createFavoriteSchema>;

export const favoriteParamsSchema = z.object({
  targetType: z.enum(['service', 'freelancer']),
  targetId: z.coerce.number().int().positive(),
});
