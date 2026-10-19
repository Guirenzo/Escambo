import { z } from 'zod';
import { isSealedField } from '../../utils/field-crypto';

// O prefixo dos valores cifrados (RNF-017) é reservado: um destino que já chegasse com ele seria
// lido como dado cifrado ilegível, e o fields:encrypt o deixaria em texto puro.
const notSealed = (v: string): boolean => !isSealedField(v);
const RESERVED = 'Valor inválido';

export const createWithdrawalSchema = z
  .object({
    // O mínimo (RN-034) vem de platform_settings e é checado no serviço. Centavo exato: o saque
    // gravado (DECIMAL 10,2) e o débito na carteira têm de ser o mesmo valor.
    amount: z.number().positive().multipleOf(0.01),
    method: z.enum(['pix', 'bank']),
    // Destino só com espaços é destino em branco: o trim vem antes do tamanho e da obrigatoriedade.
    // Os tamanhos máximos dimensionam as colunas para o texto cifrado (migration 0039).
    pixKey: z.string().trim().min(1).max(255).refine(notSealed, RESERVED).nullable().optional(),
    bankName: z.string().trim().max(100).refine(notSealed, RESERVED).nullable().optional(),
    bankAgency: z.string().trim().max(10).refine(notSealed, RESERVED).nullable().optional(),
    bankAccount: z.string().trim().max(20).refine(notSealed, RESERVED).nullable().optional(),
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
