/**
 * Service do módulo de favoritos (camada de service). É onde ficam as regras de negócio: o que
 * pode e o que não pode. Não conhece HTTP (não lê req nem escreve res) e não escreve SQL: recebe
 * dados já validados do controller e pede ao repository o que precisa do banco.
 * Quem chama: o controller (`favorites.controller.ts`).
 * O que chama: o repository (`favorites.repository.ts`) e o HttpError, para recusar com status.
 * Dentro: toFavorite (linha do banco para o formato da API) e o objeto favoritesService com
 * add (favoritar, com as duas regras), remove (desfavoritar) e list (listar).
 */
import type { Favorite, FavoriteTargetType } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { favoritesRepository, type FavoriteRow } from './favorites.repository';
import type { CreateFavoriteInput } from './favorites.schema';

/**
 * Converte uma linha da tabela (colunas em snake_case, como no MySQL) no tipo `Favorite` do pacote
 * compartilhado `@escambo/types` (camelCase), que é o mesmo que o front usa. A data vira texto ISO.
 */
function toFavorite(r: FavoriteRow): Favorite {
  return {
    id: r.id,
    targetType: r.target_type as FavoriteTargetType,
    targetId: r.target_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// O service é um objeto com as funções do módulo; os testes trocam o repository por um falso.
export const favoritesService = {
  /**
   * Favorita um serviço ou um freelancer para o usuário `userId`. Duas regras antes de gravar:
   * o alvo tem que existir (senão 404) e não pode ser seu (senão 422 `cannot_favorite_self`).
   * Não devolve nada: o controller responde 201.
   */
  async add(userId: number, input: CreateFavoriteInput): Promise<void> {
    // Pergunta ao banco quem é o dono do alvo. Para um serviço é quem o publicou; para um
    // freelancer é ele mesmo. Undefined quer dizer que o alvo não existe (ou foi excluído).
    const ownerId = await favoritesRepository.targetOwner(input.targetType, input.targetId);
    // Regra 1: alvo que não existe dá 404, com o código certo para o front saber o que faltou.
    if (ownerId === undefined) {
      throw input.targetType === 'service'
        ? new HttpError(404, 'Serviço não encontrado', 'service_not_found')
        : new HttpError(404, 'Freelancer não encontrado', 'freelancer_not_found');
    }
    // Regra 2: ninguém favorita o próprio perfil nem os próprios serviços. A tela já esconde o
    // botão nesses casos, mas a API confere de novo (validação nos dois lados).
    if (ownerId === userId) {
      throw new HttpError(
        422,
        'Você não pode favoritar o próprio perfil nem os seus serviços',
        'cannot_favorite_self',
      );
    }
    // Passou nas regras: grava. Se já era favorito, o repository não duplica nem dá erro.
    await favoritesRepository.create(userId, input.targetType, input.targetId);
  },

  /** Desfavorita. Só apaga a linha do próprio usuário; se não existia, não acontece nada. */
  async remove(userId: number, targetType: string, targetId: number): Promise<void> {
    await favoritesRepository.remove(userId, targetType, targetId);
  },

  /** Lista os favoritos do usuário, já no formato da API (o mais novo primeiro). */
  async list(userId: number): Promise<Favorite[]> {
    // Busca as linhas no repository e converte cada uma com o toFavorite.
    return (await favoritesRepository.listForUser(userId)).map(toFavorite);
  },
};
