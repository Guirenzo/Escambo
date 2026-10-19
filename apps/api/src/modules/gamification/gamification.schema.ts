import { z } from 'zod';

/**
 * Número opcional da query string: vazio (?lat=) vale como ausente, como na busca de serviços. Sem
 * isto o z.coerce.number() faz de '' um 0, e ?lat=&lng= viraria ranking em (0, 0).
 */
const queryNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

/**
 * Filtros do ranking (RF-067, RN-056). O raio não vem do cliente: é o ranking_radius_km da
 * plataforma. O tamanho também não (top 10); outras chaves da query são ignoradas.
 */
export const leaderboardQuerySchema = z
  .object({
    categoryId: queryNumber(z.coerce.number().int().positive().optional()),
    lat: queryNumber(z.coerce.number().min(-90).max(90).optional()),
    lng: queryNumber(z.coerce.number().min(-180).max(180).optional()),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: 'Informe lat e lng juntos para o ranking perto de você',
    path: ['lat'],
  });
export type LeaderboardQueryInput = z.infer<typeof leaderboardQuerySchema>;
