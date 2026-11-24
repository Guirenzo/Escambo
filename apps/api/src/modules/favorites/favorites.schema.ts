/**
 * Schemas zod do módulo de favoritos (camada de validação). Descrevem o formato que a entrada
 * precisa ter; o controller chama `.parse()` e, se a entrada não bate, o zod lança erro e o
 * error-handler responde 422 apontando o campo. O que passa já sai tipado para o TypeScript.
 * Quem usa: o controller (`favorites.controller.ts`) e o service (o tipo CreateFavoriteInput).
 * Dentro: createFavoriteSchema (corpo do POST) e favoriteParamsSchema (parâmetros do DELETE).
 */
import { z } from 'zod';

// Corpo do POST /api/favorites. Só dois tipos de alvo existem (os mesmos do ENUM da tabela), e o
// id tem que ser um número inteiro maior que zero. Texto como "12" no corpo é recusado.
export const createFavoriteSchema = z.object({
  targetType: z.enum(['service', 'freelancer']),
  targetId: z.number().int().positive(),
});
// O tipo TypeScript sai do próprio schema (z.infer): a validação e o tipo nunca ficam diferentes.
export type CreateFavoriteInput = z.infer<typeof createFavoriteSchema>;

// Parâmetros da URL do DELETE (/:targetType/:targetId). Na URL tudo chega como texto, por isso o
// z.coerce.number() converte "12" em 12 antes de conferir se é inteiro positivo.
export const favoriteParamsSchema = z.object({
  targetType: z.enum(['service', 'freelancer']),
  targetId: z.coerce.number().int().positive(),
});
