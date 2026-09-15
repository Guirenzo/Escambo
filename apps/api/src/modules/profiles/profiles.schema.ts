import { z } from 'zod';

export const upsertFreelancerSchema = z.object({
  fullName: z.string().min(2).max(150),
  avatarUrl: z.string().url().max(512).nullable().optional(),
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
    imageUrl: url.nullable().optional(),
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

export const upsertClientSchema = z.object({
  fullName: z.string().min(2).max(150),
  avatarUrl: z.string().url().max(512).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
});
export type UpsertClientInput = z.infer<typeof upsertClientSchema>;

export const ulidParamSchema = z.object({ ulid: z.string().length(26) });
