import { z } from 'zod';

export const createWithdrawalSchema = z
  .object({
    // O mínimo (RN-034) vem de platform_settings e é checado no serviço. Centavo exato: o saque
    // gravado (DECIMAL 10,2) e o débito na carteira têm de ser o mesmo valor.
    amount: z.number().positive().multipleOf(0.01),
    method: z.enum(['pix', 'bank']),
    // Destino só com espaços é destino em branco: o trim vem antes do tamanho e da obrigatoriedade.
    pixKey: z.string().trim().min(1).max(255).nullable().optional(),
    bankName: z.string().trim().max(100).nullable().optional(),
    bankAgency: z.string().trim().max(10).nullable().optional(),
    bankAccount: z.string().trim().max(20).nullable().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.method === 'pix' && !d.pixKey) {
      ctx.addIssue({ code: 'custom', path: ['pixKey'], message: 'Chave PIX obrigatória' });
    }
    if (d.method === 'bank' && (!d.bankName || !d.bankAgency || !d.bankAccount)) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankAccount'],
        message: 'Dados bancários obrigatórios',
      });
    }
  });
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;

export const withdrawalIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const listWithdrawalsSchema = z.object({
  // Teto na página: sem ele, ?page=1e20 vira OFFSET 2e+21 e o MySQL recusa (500).
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListWithdrawalsInput = z.infer<typeof listWithdrawalsSchema>;
