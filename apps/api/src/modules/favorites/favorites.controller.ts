/**
 * Controller do módulo de favoritos (camada de controller). Faz a ponte entre o HTTP e a regra:
 * lê a requisição (corpo, parâmetros da URL, usuário logado), valida a entrada com o schema zod,
 * chama o service e devolve a resposta com o status certo. Aqui não tem regra de negócio nem SQL.
 * Quem chama: as rotas (`favorites.routes.ts`), depois do authenticate.
 * O que chama: os schemas (`favorites.schema.ts`) e o service (`favorites.service.ts`).
 * Dentro: addFavorite (201), removeFavorite (204) e listFavorites (200 com a lista).
 */
import type { Request, Response } from 'express';
import { createFavoriteSchema, favoriteParamsSchema } from './favorites.schema';
import { favoritesService } from './favorites.service';

/**
 * POST /api/favorites. Recebe no corpo `{ targetType, targetId }` e favorita o alvo para quem está
 * logado. Devolve 201 (criado) com `{ ok: true }`.
 */
export async function addFavorite(req: Request, res: Response): Promise<void> {
  // Valida o corpo: se o tipo não for service/freelancer ou o id não for inteiro positivo, o zod
  // lança erro e o error-handler responde 422 com o campo errado. O que passa sai já tipado.
  const input = createFavoriteSchema.parse(req.body);
  // O id de quem favorita vem do token (req.user.uid, posto pelo authenticate), nunca do corpo:
  // assim ninguém favorita em nome de outra pessoa. O `!` diz ao TS que req.user existe aqui.
  await favoritesService.add(req.user!.uid, input);
  res.status(201).json({ ok: true });
}

/**
 * DELETE /api/favorites/:targetType/:targetId. Tira o favorito de quem está logado. Devolve 204
 * (sem corpo), exista ou não o favorito: desfavoritar duas vezes não é erro.
 */
export async function removeFavorite(req: Request, res: Response): Promise<void> {
  // Os parâmetros da URL chegam como texto; o schema converte o id para número e valida o tipo.
  const { targetType, targetId } = favoriteParamsSchema.parse(req.params);
  await favoritesService.remove(req.user!.uid, targetType, targetId);
  res.status(204).send();
}

/** GET /api/favorites. Devolve 200 com os favoritos de quem está logado (o mais novo antes). */
export async function listFavorites(req: Request, res: Response): Promise<void> {
  // Sem entrada para validar: só o id do token. O res.json responde 200 com o que o service dá.
  res.json(await favoritesService.list(req.user!.uid));
}
