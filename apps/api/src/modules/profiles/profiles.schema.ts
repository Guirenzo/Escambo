import { z } from 'zod';

export const upsertFreelancerSchema = z.object({
  fullName: z.string().min(2).max(150),
  avatarUrl: z.string().url().max(512).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  headline: z.string().max(255).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  isAvailable: z.boolean().optional(),
});
export type UpsertFreelancerInput = z.infer<typeof upsertFreelancerSchema>;

export const upsertClientSchema = z.object({
  fullName: z.string().min(2).max(150),
  avatarUrl: z.string().url().max(512).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
});
export type UpsertClientInput = z.infer<typeof upsertClientSchema>;

export const ulidParamSchema = z.object({ ulid: z.string().length(26) });
