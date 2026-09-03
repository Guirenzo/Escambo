import { z } from 'zod';

export const createWithdrawalSchema = z
  .object({
    amount: z.number().positive().min(20, 'Saque mínimo é R$ 20,00 (RN-034)'),
    method: z.enum(['pix', 'bank']),
    pixKey: z.string().min(1).max(255).nullable().optional(),
    bankName: z.string().max(100).nullable().optional(),
    bankAgency: z.string().max(10).nullable().optional(),
    bankAccount: z.string().max(20).nullable().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.method === 'pix' && !d.pixKey) {
      ctx.addIssue({ code: 'custom', path: ['pixKey'], message: 'Chave PIX obrigatória' });
    }
    if (d.method === 'bank' && (!d.bankName || !d.bankAgency || !d.bankAccount)) {
      ctx.addIssue({ code: 'custom', path: ['bankAccount'], message: 'Dados bancários obrigatórios' });
    }
  });
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;

export const listWithdrawalsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListWithdrawalsInput = z.infer<typeof listWithdrawalsSchema>;
