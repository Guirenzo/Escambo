import { z } from 'zod';

const priceType = z.enum(['fixed', 'hourly', 'negotiable']);

export const createServiceSchema = z
  .object({
    categoryId: z.number().int().positive(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    priceType: priceType.default('fixed'),
    price: z.number().positive().nullable().optional(),
    deliveryDays: z.number().int().positive().nullable().optional(),
    isRemote: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    // RN-016: serviço com preço fixo tem mínimo de R$ 10,00.
    if (data.priceType === 'fixed') {
      if (data.price == null) {
        ctx.addIssue({ code: 'custom', path: ['price'], message: 'Preço obrigatório para preço fixo' });
      } else if (data.price < 10) {
        ctx.addIssue({ code: 'custom', path: ['price'], message: 'Preço mínimo é R$ 10,00 (RN-016)' });
      }
    }
  });
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z
  .object({
    categoryId: z.number().int().positive(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    priceType,
    price: z.number().positive().nullable(),
    deliveryDays: z.number().int().positive().nullable(),
    isRemote: z.boolean(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

export const listServicesSchema = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  isRemote: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListServicesInput = z.infer<typeof listServicesSchema>;

export const serviceIdSchema = z.object({ id: z.coerce.number().int().positive() });
