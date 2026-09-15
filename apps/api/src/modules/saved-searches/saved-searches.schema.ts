import { z } from 'zod';

/** Máximo de buscas salvas por conta (ADR 35). */
export const SAVED_SEARCHES_MAX = 20;

/** Quando a busca avisa de serviço novo (ADR 37): na hora, de hora em hora ou uma vez por dia. */
export const ALERT_FREQUENCIES = ['instant', 'hourly', 'daily'] as const;
const alertFrequency = z.enum(ALERT_FREQUENCIES);

/**
 * Filtros que uma busca salva guarda (ADR 35): os mesmos da busca de serviços, sem ordenação
 * nem "atende agora" (que valem para o momento, não para um alerta). Chave desconhecida é 422.
 */
export const savedFiltersSchema = z
  .object({
    categoryId: z.number().int().positive().optional(),
    isRemote: z.boolean().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: z.number().positive().max(500).optional(),
    minPrice: z.number().min(0).optional(),
    maxPrice: z.number().positive().optional(),
    maxDeliveryDays: z.number().int().positive().optional(),
    minRating: z.number().min(0).max(5).optional(),
    day: z.number().int().min(0).max(6).optional(),
    period: z.enum(['morning', 'afternoon', 'evening']).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.period && f.day === undefined) {
      ctx.addIssue({ code: 'custom', path: ['period'], message: 'Período só junto com o dia' });
    }
    if ((f.lat === undefined) !== (f.lng === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['lat'], message: 'Latitude e longitude vão juntas' });
    }
  });
export type SavedFilters = z.infer<typeof savedFiltersSchema>;

const name = z.string().trim().min(1).max(120);

export const createSavedSearchSchema = z
  .object({
    name: name.nullable().optional(),
    query: z.string().trim().max(255).nullable().optional(),
    filters: savedFiltersSchema.nullable().optional(),
    alertEnabled: z.boolean().optional(),
    alertFrequency: alertFrequency.optional(),
  })
  .refine((d) => Boolean(d.query) || Object.keys(d.filters ?? {}).length > 0, {
    message: 'Salve uma busca com texto ou pelo menos um filtro',
    path: ['query'],
  });
export type CreateSavedSearchInput = z.infer<typeof createSavedSearchSchema>;

export const updateSavedSearchSchema = z
  .object({
    // null apaga o nome: a busca volta a aparecer pelo texto buscado.
    name: name.nullable().optional(),
    alertEnabled: z.boolean().optional(),
    alertFrequency: alertFrequency.optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'Nada para alterar',
  });
export type UpdateSavedSearchInput = z.infer<typeof updateSavedSearchSchema>;

export const savedSearchIdSchema = z.object({ id: z.coerce.number().int().positive() });
