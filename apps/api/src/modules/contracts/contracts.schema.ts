import { z } from 'zod';

export const createContractSchema = z.object({
  freelancerId: z.number().int().positive(),
  serviceId: z.number().int().positive().nullable().optional(),
  title: z.string().min(3).max(150),
  description: z.string().min(10),
  price: z.number().positive().min(10, 'Contratação mínima é R$ 10,00 (RN-027)'),
  paymentMode: z.enum(['cash', 'credits']).default('cash'),
  deadlineAt: z.string().datetime().nullable().optional(),
});
export type CreateContractInput = z.infer<typeof createContractSchema>;

export const deliverSchema = z.object({
  message: z.string().min(1),
  files: z.array(z.string().url()).max(20).optional(),
});
export type DeliverInput = z.infer<typeof deliverSchema>;

export const noteSchema = z.object({ note: z.string().max(1000).optional() });
export type NoteInput = z.infer<typeof noteSchema>;

export const contractIdSchema = z.object({ id: z.coerce.number().int().positive() });

export const listContractsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListContractsInput = z.infer<typeof listContractsSchema>;
