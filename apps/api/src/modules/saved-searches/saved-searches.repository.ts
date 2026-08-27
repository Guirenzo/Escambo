import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface SavedSearchRow extends RowDataPacket {
  id: number;
  name: string | null;
  query: string | null;
  filters: string | Record<string, unknown> | null;
  alert_enabled: number;
  created_at: Date;
}

export const savedSearchesRepository = {
  async create(d: {
    userId: number;
    name: string | null;
    query: string | null;
    filters: string | null;
    alertEnabled: boolean;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO saved_searches (user_id, name, query, filters, alert_enabled)
       VALUES (:userId, :name, :query, :filters, :alertEnabled)`,
      d,
    );
    return res.insertId;
  },

  async listForUser(userId: number): Promise<SavedSearchRow[]> {
    const [rows] = await pool.query<SavedSearchRow[]>(
      `SELECT id, name, query, filters, alert_enabled, created_at FROM saved_searches
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },

  async remove(id: number, userId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE FROM saved_searches WHERE id = :id AND user_id = :userId`,
      { id, userId },
    );
    return res.affectedRows > 0;
  },
};
