import { z } from 'zod';

const priceType = z.enum(['fixed', 'hourly', 'negotiable']);

export const createServiceSchema = z
  .object({
    categoryId: z.number().int().positive(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    priceType: priceType.default('fixed'),
    price: z.number().positive().nullable().optional(),
    deliveryDays: z.number().int().positive().nullable().optional(),
    isRemote: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    // RN-016: preço fixo exige preço; o mínimo vem de platform_settings e é checado no serviço.
    if (data.priceType === 'fixed' && data.price == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['price'],
        message: 'Preço obrigatório para preço fixo',
      });
    }
  });
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z
  .object({
    categoryId: z.number().int().positive(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    priceType,
    price: z.number().positive().nullable(),
    deliveryDays: z.number().int().positive().nullable(),
    isRemote: z.boolean(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

/**
 * Número opcional da busca vindo da query string: vazio (?lat=) vale como ausente. Sem isto o
 * z.coerce.number() faz de '' um 0, e ?lat=&lng= vira busca em (0, 0), ?minPrice= tira os sem preço.
 */
const queryNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

export const listServicesSchema = z.object({
  categoryId: queryNumber(z.coerce.number().int().positive().optional()),
  /** Serviços de um freelancer específico (perfil público). */
  ownerId: queryNumber(z.coerce.number().int().positive().optional()),
  q: z.string().trim().min(1).optional(),
  isRemote: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  // Descoberta local: com lat+lng, ranqueia por proximidade dentro de radiusKm.
  lat: queryNumber(z.coerce.number().min(-90).max(90).optional()),
  lng: queryNumber(z.coerce.number().min(-180).max(180).optional()),
  radiusKm: queryNumber(z.coerce.number().positive().max(500).default(25)),
  // Filtros: faixa de preço (serviço sem preço fica de fora quando há filtro), prazo e nota do prestador.
  minPrice: queryNumber(z.coerce.number().min(0).optional()),
  maxPrice: queryNumber(z.coerce.number().positive().optional()),
  maxDeliveryDays: queryNumber(z.coerce.number().int().positive().optional()),
  minRating: queryNumber(z.coerce.number().min(0).max(5).optional()),
  // Dia da semana em que o prestador atende (0=domingo … 6=sábado). Quem não informou os
  // dias fica de fora quando há filtro: "atende sábado" é uma afirmação, não um palpite.
  day: queryNumber(z.coerce.number().int().min(0).max(6).optional()),
  // Período do dia em que atende, junto com `day` (ADR 34), no fuso do freelancer. Dia sem períodos = o dia todo.
  period: z.enum(['morning', 'afternoon', 'evening']).optional(),
  // Atende agora: aceitando pedidos, no dia e no período de agora no fuso de cada freelancer (ADR 48).
  now: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  // Ordenação: relevância (destaque + recência, ou destaque + proximidade com lat/lng),
  // preço, nota, recência ou distância (só faz sentido com lat/lng; sem eles cai na relevância).
  sort: z
    .enum(['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'distance'])
    .default('relevance'),
  page: queryNumber(z.coerce.number().int().positive().max(10_000).default(1)),
  limit: queryNumber(z.coerce.number().int().positive().max(100).default(20)),
});
export type ListServicesInput = z.infer<typeof listServicesSchema>;
export type ServiceSort = ListServicesInput['sort'];

export const serviceIdSchema = z.object({ id: z.coerce.number().int().positive() });
