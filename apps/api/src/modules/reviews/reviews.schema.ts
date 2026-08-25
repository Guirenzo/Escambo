import { z } from 'zod';

export const createReviewSchema = z.object({
  contractId: z.number().int().positive(),
  rating: z.number().int().min(1).max(5), // RF-052
  comment: z.string().max(1000).nullable().optional(),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const respondReviewSchema = z.object({
  response: z.string().min(1).max(1000),
});
export type RespondReviewInput = z.infer<typeof respondReviewSchema>;

export const reviewIdSchema = z.object({ id: z.coerce.number().int().positive() });

export const listReviewsSchema = z.object({
  freelancerId: z.coerce.number().int().positive(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListReviewsInput = z.infer<typeof listReviewsSchema>;
