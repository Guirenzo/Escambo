/**
 * Rotas do módulo de favoritos (camada de rota). É a primeira camada do back: diz qual URL e qual
 * verbo HTTP chamam qual função do controller, e quais middlewares rodam antes.
 * Quem chama: o `routes.ts` da API monta este Router em `/api/favorites`; do lado do web, o
 * `lib/api.ts` faz o GET, o POST e o DELETE para cá (o coração de favoritar no cartão do serviço).
 * O que chama: o controller (`favorites.controller.ts`), que chama o service, que chama o
 * repository, que fala com a tabela `favorites` do MySQL.
 * Dentro: o `authenticate` para todas as rotas e três endpoints (favoritar, listar, desfavoritar).
 * O módulo de favoritos é o exemplo pequeno das camadas: todo módulo da API segue o mesmo caminho.
 */
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { addFavorite, listFavorites, removeFavorite } from './favorites.controller';

// O Router do Express é um "mini app" só com as rotas deste módulo; o routes.ts dá o prefixo.
export const favoritesRoutes = Router();

// Todas as rotas abaixo exigem login: o authenticate confere o JWT do cabeçalho Authorization e
// põe o usuário em req.user. Sem token válido a resposta é 401 e o controller nem roda.
favoritesRoutes.use(authenticate);
// O asyncHandler envolve cada função assíncrona: se ela lançar erro (zod, HttpError), o erro vai
// para o error-handler global, que monta a resposta em JSON. Assim não tem try/catch em cada uma.
// POST /api/favorites: favorita um serviço ou um freelancer (o alvo vem no corpo).
favoritesRoutes.post('/', asyncHandler(addFavorite));
// GET /api/favorites: lista os favoritos de quem está logado.
favoritesRoutes.get('/', asyncHandler(listFavorites));
// DELETE /api/favorites/service/12: desfavorita; o tipo e o id do alvo vêm na própria URL.
favoritesRoutes.delete('/:targetType/:targetId', asyncHandler(removeFavorite));
