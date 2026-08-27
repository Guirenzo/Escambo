import { z } from 'zod';

export const recordConsentSchema = z.object({
  type: z.enum(['terms_of_use', 'privacy_policy', 'marketing', 'data_processing']),
  version: z.string().min(1).max(20),
  accepted: z.boolean(),
});
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;

export const deletionRequestSchema = z.object({
  reason: z.string().max(1000).nullable().optional(),
});
export type DeletionRequestInput = z.infer<typeof deletionRequestSchema>;
