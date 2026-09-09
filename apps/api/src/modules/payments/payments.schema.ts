import { z } from 'zod';

export const createDepositSchema = z.object({
  amount: z
    .number()
    .positive()
    .min(10, 'Depósito mínimo é R$ 10,00')
    .max(50_000, 'Depósito máximo é R$ 50.000,00')
    .multipleOf(0.01),
  method: z.enum(['pix']).default('pix'),
});
export type CreateDepositInput = z.infer<typeof createDepositSchema>;

export const depositIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const listDepositsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/** Evento do gateway: "cobrança X mudou para pago/falhou". */
export const webhookSchema = z.object({
  event: z.string().max(60).optional(),
  gatewayPaymentId: z.string().min(1).max(100),
  status: z.enum(['paid', 'failed']),
});
export type WebhookInput = z.infer<typeof webhookSchema>;
