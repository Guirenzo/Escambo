import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface FavoriteRow extends RowDataPacket {
  id: number;
  target_type: string;
  target_id: number;
  created_at: Date;
}

export const favoritesRepository = {
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
