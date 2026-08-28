import { z } from 'zod';

export const openDisputeSchema = z.object({
  contractId: z.number().int().positive(),
  reason: z.enum(['not_delivered', 'quality', 'deadline', 'scope', 'payment', 'other']),
  description: z.string().min(10).max(2000),
});
export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;

export const disputeIdSchema = z.object({ id: z.coerce.number().int().positive() });
