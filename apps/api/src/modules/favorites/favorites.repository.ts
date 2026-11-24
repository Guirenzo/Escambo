/**
 * Repository do módulo de favoritos (camada de repository). É a única camada que fala com o
 * banco: cada função roda uma consulta SQL no MySQL pelo pool do mysql2 e devolve os dados crus.
 * Não tem regra de negócio (quem decide se pode é o service).
 * Quem chama: o service (`favorites.service.ts`).
 * O que chama: o `pool` de conexões (`config/db.ts`), que fala com as tabelas `favorites`,
 * `services`, `users` e `profiles_freelancer`.
 * Os valores entram como parâmetros nomeados (`:userId`), nunca colados no texto do SQL: o mysql2
 * escapa cada um, e isso impede SQL injection.
 * Dentro: targetOwner (dono do alvo), create (grava), remove (apaga) e listForUser (lista).
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

/**
 * Formato de uma linha da tabela `favorites`, com os nomes das colunas do banco. A chave única
 * `uq_favorite` (usuário, tipo, alvo) no schema.sql garante um favorito só por alvo.
 */
export interface FavoriteRow extends RowDataPacket {
  id: number;
  target_type: string;
  target_id: number;
  created_at: Date;
}

export const favoritesRepository = {
  /**
   * Dono do alvo do favorito (o freelancer é o próprio usuário), ou undefined se o alvo não existe:
   * serviço removido ou conta excluída não contam. A tabela favorites não tem FK para o alvo.
   */
  async targetOwner(targetType: string, targetId: number): Promise<number | undefined> {
    // Duas consultas possíveis, escolhidas pelo tipo. Serviço: busca o user_id do serviço, se ele
    // não foi apagado. Freelancer: busca o usuário que tem perfil de freelancer e não foi excluído.
    // O LIMIT 1 para na primeira linha; o `[rows]` pega só as linhas do que o mysql2 devolve.
    const [rows] = await pool.query<RowDataPacket[]>(
      targetType === 'service'
        ? `SELECT user_id FROM services WHERE id = :targetId AND deleted_at IS NULL LIMIT 1`
        : `SELECT u.id AS user_id FROM users u
             JOIN profiles_freelancer pf ON pf.user_id = u.id
            WHERE u.id = :targetId AND u.deleted_at IS NULL LIMIT 1`,
      { targetId },
    );
    // Achou: devolve o id do dono como número. Não achou: undefined (o service transforma em 404).
    return rows[0] ? Number(rows[0].user_id) : undefined;
  },

  /**
   * Grava o favorito (usuário, tipo do alvo, id do alvo). A data de criação o próprio banco põe.
   * A gravação usa o IGNORE do MySQL: se a chave única já existe (o mesmo favorito de novo, ou
   * dois cliques rápidos), o banco não grava a segunda linha e não dá erro. Por isso é idempotente.
   */
  async create(userId: number, targetType: string, targetId: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO favorites (user_id, target_type, target_id)
       VALUES (:userId, :targetType, :targetId)`,
      { userId, targetType, targetId },
    );
  },

  /**
   * Apaga o favorito. O filtro tem o user_id de quem pediu: uma pessoa só consegue apagar os
   * próprios favoritos. Se a linha não existe, o banco apaga zero linhas e não é erro.
   */
  async remove(userId: number, targetType: string, targetId: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `DELETE FROM favorites
        WHERE user_id = :userId AND target_type = :targetType AND target_id = :targetId`,
      { userId, targetType, targetId },
    );
  },

  /**
   * Os favoritos de um usuário, do mais novo para o mais antigo (id maior primeiro). O índice
   * `idx_fav_user` deixa essa busca por usuário rápida.
   */
  async listForUser(userId: number): Promise<FavoriteRow[]> {
    // Busca só as colunas que a API devolve, filtrando pelo dono, em ordem decrescente de id.
    const [rows] = await pool.query<FavoriteRow[]>(
      `SELECT id, target_type, target_id, created_at FROM favorites
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },
};
