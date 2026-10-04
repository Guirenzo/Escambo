import { z } from 'zod';

export const openDisputeSchema = z.object({
  contractId: z.number().int().positive(),
  reason: z.enum(['not_delivered', 'quality', 'deadline', 'scope', 'payment', 'other']),
  // Trim antes do mínimo: dez espaços não são descrição e não podem travar o escrow (RN-038).
  description: z.string().trim().min(10).max(2000),
});
export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;

export const disputeIdSchema = z.object({ id: z.coerce.number().int().positive() });
