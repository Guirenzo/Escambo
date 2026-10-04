import { z } from 'zod';

/**
 * Valor estimado de um lado da troca: centavo exato e no limite da coluna DECIMAL(10,2). Com
 * fração de centavo o banco arredondaria cada lado e a torna (calculada antes) não bateria.
 */
const estimatedValue = z
  .number()
  .positive()
  .multipleOf(0.01)
  .max(99_999_999.99, 'Valor estimado máximo é R$ 99.999.999,99');

export const createBarterSchema = z
  .object({
    receiverId: z.number().int().positive(),
    offeredServiceId: z.number().int().positive().nullable().optional(),
    offeredDescription: z.string().min(3).max(1000).nullable().optional(),
    requestedServiceId: z.number().int().positive().nullable().optional(),
    requestedDescription: z.string().min(3).max(1000).nullable().optional(),
    estimatedValueOffered: estimatedValue,
    estimatedValueRequested: estimatedValue,
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
  // Teto na página: sem ele, ?page=1e20 vira OFFSET 2e+21 e o MySQL recusa (500).
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListBartersInput = z.infer<typeof listBartersSchema>;
