import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

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
    const [rows] = await pool.query<RowDataPacket[]>(
      targetType === 'service'
        ? `SELECT user_id FROM services WHERE id = :targetId AND deleted_at IS NULL LIMIT 1`
        : `SELECT u.id AS user_id FROM users u
             JOIN profiles_freelancer pf ON pf.user_id = u.id
            WHERE u.id = :targetId AND u.deleted_at IS NULL LIMIT 1`,
      { targetId },
    );
    return rows[0] ? Number(rows[0].user_id) : undefined;
  },

  async create(userId: number, targetType: string, targetId: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO favorites (user_id, target_type, target_id)
       VALUES (:userId, :targetType, :targetId)`,
      { userId, targetType, targetId },
    );
  },

  async remove(userId: number, targetType: string, targetId: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `DELETE FROM favorites
        WHERE user_id = :userId AND target_type = :targetType AND target_id = :targetId`,
      { userId, targetType, targetId },
    );
  },

  async listForUser(userId: number): Promise<FavoriteRow[]> {
    const [rows] = await pool.query<FavoriteRow[]>(
      `SELECT id, target_type, target_id, created_at FROM favorites
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },
};
