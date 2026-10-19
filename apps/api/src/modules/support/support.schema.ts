import { z } from 'zod';

export const supportIdSchema = z.object({ id: z.coerce.number().int().positive().safe() });
export const supportListSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    status: z.enum(['open', 'in_progress', 'waiting_user', 'resolved', 'closed']).optional(),
  })
  .strict();
export const supportDetailSchema = z
  .object({ beforeId: z.coerce.number().int().positive().safe().optional() })
  .strict();
export const createSupportSchema = z
  .object({
    category: z.enum(['payment', 'dispute', 'account', 'fraud', 'other']),
    subject: z.string().trim().min(3).max(150),
    description: z.string().trim().min(10).max(5000),
    contractId: z.number().int().positive().safe().nullable().optional(),
  })
  .strict()
  .refine((v) => v.category !== 'dispute' || v.contractId != null, {
    path: ['contractId'],
    message: 'Informe a contratação relacionada',
  });
export const replySupportSchema = z
  .object({ message: z.string().trim().min(1).max(5000) })
  .strict();
export const adminReplySupportSchema = replySupportSchema
  .extend({ internal: z.boolean().default(false), resolve: z.boolean().default(false) })
  .strict()
  .refine((v) => !(v.internal && v.resolve), {
    message: 'A resolução exige uma resposta pública',
  });
export const updateSupportSchema = z
  .object({
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    status: z.enum(['in_progress', 'waiting_user']).optional(),
  })
  .strict()
  .refine((v) => v.priority !== undefined || v.status !== undefined, {
    message: 'Informe a prioridade ou o estado',
  });
export const closeSupportSchema = z.object({}).strict().default({});
