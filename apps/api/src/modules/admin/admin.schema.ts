import { z } from 'zod';

export const resolveDisputeSchema = z
  .object({
    resolution: z.enum(['refund_client', 'release_freelancer', 'partial_split']),
    refundPercentage: z.number().int().min(0).max(100).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.resolution === 'partial_split' && d.refundPercentage == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['refundPercentage'],
        message: 'refundPercentage é obrigatório em partial_split',
      });
    }
  });
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;

export const disputeIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const userUlidSchema = z.object({ ulid: z.string().length(26) });
