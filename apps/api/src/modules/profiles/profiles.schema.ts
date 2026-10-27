import { z } from 'zod';
import {
  isValidCnpj,
  isValidCpf,
  normalizeCnpj,
  normalizeCpf,
  parseIsoDay,
} from '../../utils/documents';
import { MEDIA_URL_RE } from '../media/media.paths';

/** Imagem por link externo ou enviada pela plataforma (/api/media/AAAA/MM/<ULID>.<ext>, ADR 36). */
const imageRef = z.union([
  z.string().url().max(512),
  z.string().regex(MEDIA_URL_RE, 'Imagem enviada inválida'),
]);

export const upsertFreelancerSchema = z.object({
  fullName: z.string().min(2).max(150),
  avatarUrl: imageRef.nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  headline: z.string().max(255).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  isAvailable: z.boolean().optional(),
  // Dias da semana em que atende (0 = domingo … 6 = sábado).
  availableDays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  // Por dia marcado, os períodos em que atende (dia sem chave = o dia todo), ADR 34.
  availablePeriods: z
    .record(
      z.string().regex(/^[0-6]$/),
      z.array(z.enum(['morning', 'afternoon', 'evening'])).max(3),
    )
    .nullable()
    .optional(),
});
export type UpsertFreelancerInput = z.infer<typeof upsertFreelancerSchema>;

const url = z.string().url().max(512);
export const portfolioItemSchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    description: z.string().max(1000).nullable().optional(),
    imageUrl: imageRef.nullable().optional(),
    externalUrl: url.nullable().optional(),
  })
  .refine((d) => d.imageUrl || d.externalUrl, {
    message: 'Informe a imagem ou o link do trabalho',
    path: ['imageUrl'],
  });
export type PortfolioItemInput = z.infer<typeof portfolioItemSchema>;

export const portfolioIdSchema = z.object({ id: z.coerce.number().int().positive() });

/** Limite de itens no portfólio (RF de perfil): o suficiente para mostrar o trabalho sem virar depósito. */
export const PORTFOLIO_MAX_ITEMS = 12;

/** Nova ordem do portfólio (ADR 43): cada trabalho uma vez, do primeiro ao último. */
export const portfolioOrderSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(PORTFOLIO_MAX_ITEMS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Trabalho repetido na ordem' }),
});

export const upsertClientSchema = z.object({
  fullName: z.string().min(2).max(150),
  avatarUrl: imageRef.nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
});
export type UpsertClientInput = z.infer<typeof upsertClientSchema>;

export const ulidParamSchema = z.object({ ulid: z.string().length(26) });

// ---------- Documentos (RF-018, RF-020) ----------

export const CNPJ_INVALID_MESSAGE =
  'CNPJ inválido: confira os 14 caracteres (números, ou letras e números no CNPJ alfanumérico) e os dígitos verificadores';
export const CPF_INVALID_MESSAGE = 'CPF inválido: confira os 11 dígitos';

/**
 * CNPJ com ou sem máscara, numérico ou alfanumérico (IN RFB 2.229/2024): sai normalizado (14
 * caracteres, maiúsculas, sem máscara) e com os dígitos verificadores conferidos.
 */
export const cnpjSchema = z
  .string({ error: CNPJ_INVALID_MESSAGE })
  .max(30, CNPJ_INVALID_MESSAGE)
  .transform((value, ctx) => {
    const cnpj = normalizeCnpj(value);
    if (cnpj && isValidCnpj(cnpj)) return cnpj;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: CNPJ_INVALID_MESSAGE });
    return z.NEVER;
  });

/** O que o cadastro de empresa exige (RF-018): razão social, nome fantasia e CNPJ. */
export const companySignupSchema = z.object({
  legalName: z
    .string({ error: 'Informe a razão social' })
    .trim()
    .min(2, 'A razão social precisa de ao menos 2 caracteres')
    .max(150, 'A razão social tem no máximo 150 caracteres'),
  tradeName: z
    .string({ error: 'Informe o nome fantasia' })
    .trim()
    .min(2, 'O nome fantasia precisa de ao menos 2 caracteres')
    .max(150, 'O nome fantasia tem no máximo 150 caracteres'),
  cnpj: cnpjSchema,
});
export type CompanySignupInput = z.infer<typeof companySignupSchema>;

/** Site da empresa: só http(s); vazio apaga. */
const website = z
  .string()
  .trim()
  .max(255, 'O site tem no máximo 255 caracteres')
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value == null || value === '') return null;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      /* cai na mensagem abaixo */
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Site inválido: use o endereço completo, como https://suaempresa.com.br',
    });
    return z.NEVER;
  });

/** PUT /profiles/company: os do cadastro continuam obrigatórios; logo, site e descrição curta. */
export const upsertCompanySchema = companySignupSchema.extend({
  logoUrl: imageRef.nullable().optional(),
  bio: z
    .string()
    .trim()
    .max(280, 'A descrição curta tem no máximo 280 caracteres')
    .nullable()
    .optional(),
  website,
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().length(2).nullable().optional(),
});
export type UpsertCompanyInput = z.infer<typeof upsertCompanySchema>;

/**
 * PUT /profiles/me/cpf (RF-020): CPF com ou sem máscara (sai com os 11 dígitos, verificadores
 * conferidos) e a data de nascimento AAAA-MM-DD que existe no calendário. A idade, que depende do
 * dia de hoje no fuso da conta, é conferida no service.
 */
export const verifyCpfSchema = z.object({
  cpf: z
    .string({ error: CPF_INVALID_MESSAGE })
    .max(20, CPF_INVALID_MESSAGE)
    .transform((value, ctx) => {
      const cpf = normalizeCpf(value);
      if (cpf && isValidCpf(cpf)) return cpf;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CPF_INVALID_MESSAGE });
      return z.NEVER;
    }),
  // De 1900 em diante: antes disso é erro de digitação (o "hoje" fica para o service).
  birthDate: z
    .string({ error: 'Informe a data de nascimento' })
    .refine((v) => parseIsoDay(v) !== null && v >= '1900-01-01', 'Data de nascimento inválida'),
});
export type VerifyCpfInput = z.infer<typeof verifyCpfSchema>;
