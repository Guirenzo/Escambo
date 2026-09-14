import { z } from 'zod';

const milestoneSchema = z.object({
  title: z.string().min(3).max(150),
  description: z.string().max(1000).nullable().optional(),
  amount: z.number().positive().multipleOf(0.01),
  dueAt: z.string().datetime().nullable().optional(),
});

export const createContractSchema = z
  .object({
    freelancerId: z.number().int().positive(),
    serviceId: z.number().int().positive().nullable().optional(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    price: z.number().positive().min(10, 'Contratação mínima é R$ 10,00 (RN-027)'),
    paymentMode: z.enum(['cash', 'credits']).default('cash'),
    deadlineAt: z.string().datetime().nullable().optional(),
    // Escrow por marcos (RN-069): 2 a 10 marcos, só em dinheiro, soma igual ao valor.
    milestones: z.array(milestoneSchema).min(2).max(10).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.deadlineAt && new Date(d.deadlineAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'O prazo de entrega precisa estar no futuro',
      });
    }
    if (!d.milestones) return;
    // Em créditos (time-bank) cada marco é um número inteiro de créditos, sem taxa.
    if (d.paymentMode === 'credits') {
      d.milestones.forEach((m, i) => {
        if (!Number.isInteger(m.amount)) {
          ctx.addIssue({
            code: 'custom',
            path: ['milestones', i, 'amount'],
            message: `O marco ${i + 1} precisa ter um número inteiro de créditos`,
          });
        }
      });
    }
    const sum = d.milestones.reduce((acc, m) => acc + m.amount, 0);
    if (Math.abs(sum - d.price) > 0.005) {
      ctx.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: 'A soma dos marcos precisa ser igual ao valor da contratação (RN-069)',
      });
    }
    // Prazo por marco: opcional; no futuro, em ordem e nunca depois do prazo da contratação.
    const deadline = d.deadlineAt ? new Date(d.deadlineAt).getTime() : null;
    let previous = 0;
    d.milestones.forEach((m, i) => {
      if (!m.dueAt) return;
      const t = new Date(m.dueAt).getTime();
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', path: ['milestones', i, 'dueAt'], message });
      if (t <= Date.now()) issue(`O prazo do marco ${i + 1} precisa estar no futuro`);
      if (t < previous) {
        issue(`O prazo do marco ${i + 1} precisa ser igual ou depois do marco anterior`);
      }
      if (deadline !== null && t > deadline) {
        issue(`O prazo do marco ${i + 1} não pode passar do prazo da contratação`);
      }
      previous = t;
    });
  });
export type CreateContractInput = z.infer<typeof createContractSchema>;

export const milestoneParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  milestoneId: z.coerce.number().int().positive(),
});

export const deliverSchema = z.object({
  message: z.string().min(1),
  files: z.array(z.string().url()).max(20).optional(),
});
export type DeliverInput = z.infer<typeof deliverSchema>;

export const noteSchema = z.object({ note: z.string().max(1000).optional() });
export type NoteInput = z.infer<typeof noteSchema>;

export const contractIdSchema = z.object({ id: z.coerce.number().int().positive() });

/** Pedido de extensão de prazo (RN-028): novo prazo e o motivo, que o cliente lê. */
export const extensionSchema = z.object({
  deadlineAt: z.string().datetime(),
  reason: z.string().trim().min(5, 'Explique o motivo em ao menos 5 caracteres').max(500),
});
export type ExtensionInput = z.infer<typeof extensionSchema>;

export const extensionDecisionSchema = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(['accept', 'decline']),
});

export const listContractsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListContractsInput = z.infer<typeof listContractsSchema>;
