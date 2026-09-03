import { z } from 'zod';

export const createBarterSchema = z
  .object({
    receiverId: z.number().int().positive(),
    offeredServiceId: z.number().int().positive().nullable().optional(),
    offeredDescription: z.string().min(3).max(1000).nullable().optional(),
    requestedServiceId: z.number().int().positive().nullable().optional(),
    requestedDescription: z.string().min(3).max(1000).nullable().optional(),
    estimatedValueOffered: z.number().positive(),
    estimatedValueRequested: z.number().positive(),
  })
  .superRefine((d, ctx) => {
    if (!d.offeredServiceId && !d.offeredDescription) {
      ctx.addIssue({
        code: 'custom',
        path: ['offeredServiceId'],
        message: 'Informe um serviço ou descrição do que você oferece',
      });
    }
    if (!d.requestedServiceId && !d.requestedDescription) {
      ctx.addIssue({
        code: 'custom',
        path: ['requestedServiceId'],
        message: 'Informe um serviço ou descrição do que você quer em troca',
      });
    }
  });
export type CreateBarterInput = z.infer<typeof createBarterSchema>;

export const barterIdSchema = z.object({ id: z.coerce.number().int().positive() });

export const listBartersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListBartersInput = z.infer<typeof listBartersSchema>;
