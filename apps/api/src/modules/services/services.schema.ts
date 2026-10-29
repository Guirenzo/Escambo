import { z } from 'zod';
import { packagesSchema } from './service-packages';
import { tagsSchema } from './service-tags';

const priceType = z.enum(['fixed', 'hourly', 'negotiable']);
/**
 * Modalidade (RF-023): remoto, presencial ou os dois. Quem ainda manda só isRemote continua valendo
 * (true = remoto, false = presencial); com modality junto, vale a modality.
 */
const modality = z.enum(['remote', 'onsite', 'both']);

export const createServiceSchema = z
  .object({
    categoryId: z.number().int().positive(),
    title: z.string().min(3).max(150),
    description: z.string().min(10),
    priceType: priceType.default('fixed'),
    price: z.number().positive().nullable().optional(),
    deliveryDays: z.number().int().positive().nullable().optional(),
    isRemote: z.boolean().default(false),
    modality: modality.optional(),
    // RN-018: até 10, de 2 a 30 caracteres, normalizadas e sem repetir.
    tags: tagsSchema.optional(),
    // RF-086/RN-068: até 3 pacotes (Básico obrigatório); com eles, preço e prazo saem do Básico.
    packages: packagesSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // RN-016: preço fixo exige preço; o mínimo vem de platform_settings e é checado no serviço.
    // Com pacotes, o preço é o do Básico (o service confere e grava).
    if (data.priceType === 'fixed' && data.price == null && !data.packages?.length) {
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
    modality,
    // A lista inteira substitui as tags do serviço; [] tira todas.
    tags: tagsSchema,
    // A lista inteira substitui os pacotes; [] tira todos (o preço volta a ser o do serviço).
    packages: packagesSchema,
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
  // Até 255, como o texto da busca salva. Vai ao FULLTEXT e às tags (service-search.ts).
  q: z.string().trim().min(1).max(255).optional(),
  // true = atende remoto, false = atende presencial; quem atende dos dois jeitos entra nos dois.
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
