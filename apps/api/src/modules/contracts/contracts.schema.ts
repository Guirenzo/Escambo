import { z } from 'zod';

/** Teto de DECIMAL(10,2), a coluna do valor da contratação e do marco. */
export const MAX_CONTRACT_AMOUNT = 99_999_999.99;
const MAX_AMOUNT_MESSAGE = 'O valor máximo é R$ 99.999.999,99';
/**
 * Centavo exato (ADR 60): a coluna é DECIMAL(10,2) e a carteira soma o número que chega. Com
 * 10,005 a contratação gravava 10,01, reservava 10,00 do saldo e devolvia 10,01 no cancelamento.
 */
const CENTS_MESSAGE = 'O valor vai até os centavos: no máximo duas casas decimais';

const milestoneSchema = z.object({
  title: z.string().min(3).max(150),
  description: z.string().max(1000).nullable().optional(),
  amount: z
    .number()
    .positive()
    .multipleOf(0.01, CENTS_MESSAGE)
    .max(MAX_CONTRACT_AMOUNT, MAX_AMOUNT_MESSAGE),
  dueAt: z.string().datetime().nullable().optional(),
});

export const createContractSchema = z
  .object({
    freelancerId: z.number().int().positive(),
    serviceId: z.number().int().positive().nullable().optional(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    price: z
      .number()
      .positive()
      .multipleOf(0.01, CENTS_MESSAGE)
      .min(10, 'Contratação mínima é R$ 10,00 (RN-027)')
      .max(MAX_CONTRACT_AMOUNT, MAX_AMOUNT_MESSAGE),
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

const offerSeqSchema = z.number().int().min(1).max(5);
const counterMilestoneSchema = z
  .object({
    id: z.number().int().positive(),
    amount: z
      .number()
      .positive()
      .multipleOf(0.01, CENTS_MESSAGE)
      .max(MAX_CONTRACT_AMOUNT, MAX_AMOUNT_MESSAGE),
    dueAt: z.string().datetime().nullable(),
  })
  .strict();

/** RN-030: os termos completos da oferta; forma e unidade vêm do contrato, nunca do corpo. */
export const counterOfferSchema = z
  .object({
    seq: offerSeqSchema,
    price: z
      .number()
      .multipleOf(0.01, CENTS_MESSAGE)
      .min(10, 'Contratação mínima é R$ 10,00 (RN-027)')
      .max(MAX_CONTRACT_AMOUNT, MAX_AMOUNT_MESSAGE),
    deadlineAt: z.string().datetime().nullable(),
    milestones: z.array(counterMilestoneSchema).min(2).max(10).optional(),
    message: z
      .string()
      .trim()
      .min(5, 'Explique a contraproposta em ao menos 5 caracteres')
      .max(500),
  })
  .strict()
  .superRefine((d, ctx) => {
    const now = Date.now();
    const deadline = d.deadlineAt ? new Date(d.deadlineAt).getTime() : null;
    if (deadline !== null && deadline <= now) {
      ctx.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'O prazo de entrega precisa estar no futuro',
      });
    }
    if (!d.milestones) return;
    if (new Set(d.milestones.map((m) => m.id)).size !== d.milestones.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: 'Cada marco precisa aparecer uma única vez',
      });
    }
    const sum = d.milestones.reduce((cents, m) => cents + Math.round(m.amount * 100), 0);
    if (sum !== Math.round(d.price * 100)) {
      ctx.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: 'A soma dos marcos precisa ser igual ao valor da contratação (RN-069)',
      });
    }
    let previous = 0;
    d.milestones.forEach((m, i) => {
      if (!m.dueAt) return;
      const due = new Date(m.dueAt).getTime();
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', path: ['milestones', i, 'dueAt'], message });
      if (due <= now) issue(`O prazo do marco ${i + 1} precisa estar no futuro`);
      if (due < previous)
        issue(`O prazo do marco ${i + 1} precisa ser igual ou depois do marco anterior`);
      if (deadline !== null && due > deadline) {
        issue(`O prazo do marco ${i + 1} não pode passar do prazo da contratação`);
      }
      previous = due;
    });
  });
export type CounterOfferInput = z.infer<typeof counterOfferSchema>;

/** O service exige a sequência nas negociações; corpo vazio continua válido só na oferta 1. */
export const offerDecisionBodySchema = z
  .object({ seq: offerSeqSchema.optional() })
  .strict()
  .default({});
export const offerAcceptParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  seq: z.coerce.number().int().min(1).max(5),
});

export const milestoneParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  milestoneId: z.coerce.number().int().positive(),
});

export const deliverSchema = z.object({
  message: z.string().min(1),
  files: z.array(z.string().url()).max(20).optional(),
});
export type DeliverInput = z.infer<typeof deliverSchema>;

/**
 * A mesma entrega em multipart, quando leva arquivos (RF-035): os arquivos vêm no campo
 * `attachments` (req.files) e os links, se houver, em `files` repetido, que chega como texto ou
 * lista de textos.
 */
export const deliverFormSchema = deliverSchema.extend({
  files: z.preprocess(
    (v) => (typeof v === 'string' ? [v] : v),
    z.array(z.string().url()).max(20).optional(),
  ),
});

/**
 * Entrega de um marco: a mensagem (o marco guarda delivery_note) e, em multipart, os arquivos no
 * campo `attachments` (RF-035). Links não têm onde ficar no marco: `files` ou outra chave qualquer
 * é 422, em vez de aceito e descartado em silêncio.
 */
export const deliverMilestoneSchema = z
  .object({
    message: z.string().min(1),
    files: z
      .never({
        invalid_type_error:
          'A entrega de um marco não leva links: anexe os arquivos ou escreva o link na mensagem',
      })
      .optional(),
  })
  .strict();

export const noteSchema = z.object({ note: z.string().max(1000).optional() });
export type NoteInput = z.infer<typeof noteSchema>;

/** A liberação concede exatamente uma revisão; o limite nunca vem do corpo da requisição. */
export const grantRevisionBodySchema = z.object({}).strict().default({});

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

/**
 * Corpo da decisão (ADR 57): o número do pedido que o cliente viu. Opcional para quem chama a
 * API sem ele; com ele, um pedido trocado no meio responde 409 extension_changed.
 */
export const extensionDecisionBodySchema = z
  .object({ seq: z.number().int().min(0).max(2).optional() })
  .default({});

/** Corpo do cancelamento (ADR 57): o reembolso que a pessoa viu na tela. */
export const cancelBodySchema = z
  .object({
    expectedRefund: z.number().min(0).optional(),
    seq: offerSeqSchema.optional(),
    expectedDropoutCount: z.number().int().min(1).optional(),
  })
  .strict()
  .default({});
export type CancelBody = z.infer<typeof cancelBodySchema>;

export const CONTRACT_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'in_progress',
  'delivered',
  'revision_requested',
  'completed',
  'cancelled',
  'disputed',
] as const;

/**
 * Filtro por status da lista (RF-040): `?status=accepted,in_progress` ou o parâmetro repetido.
 * Vazio vale como sem filtro; status desconhecido é 422, em vez de uma lista vazia sem explicação.
 */
const statusFilterSchema = z.preprocess(
  (v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v])
      .flatMap((p) => (typeof p === 'string' ? p.split(',') : [p]))
      .map((p) => (typeof p === 'string' ? p.trim() : p))
      .filter((p) => p !== '');
    return parts.length === 0 ? undefined : [...new Set(parts)];
  },
  z.array(z.enum(CONTRACT_STATUSES, { message: 'Status de contratação desconhecido' })).optional(),
);

export const listContractsSchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: statusFilterSchema,
});
export type ListContractsInput = z.infer<typeof listContractsSchema>;
