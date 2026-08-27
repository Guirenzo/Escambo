import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface NotificationRow extends RowDataPacket {
  id: number;
  type: string;
  title: string;
  body: string | null;
  data: string | Record<string, unknown> | null;
  is_read: number;
  created_at: Date;
}

export const notificationsRepository = {
  async create(d: {
    userId: number;
    type: string;
    title: string;
    body: string | null;
    data: string | null;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO notifications (user_id, type, title, body, data, channel)
       VALUES (:userId, :type, :title, :body, :data, 'in_app')`,
      d,
    );
    return res.insertId;
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<NotificationRow[]> {
    const [rows] = await pool.query<NotificationRow[]>(
      `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications WHERE user_id = :userId
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  async countUnread(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = :userId AND is_read = 0`,
      { userId },
    );
    return Number(rows[0]?.c ?? 0);
  },

  async markRead(id: number, userId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE notifications SET is_read = 1, read_at = NOW()
        WHERE id = :id AND user_id = :userId AND is_read = 0`,
      { id, userId },
    );
    return res.affectedRows > 0;
  },

  async markAllRead(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE notifications SET is_read = 1, read_at = NOW()
        WHERE user_id = :userId AND is_read = 0`,
      { userId },
    );
    return res.affectedRows;
  },
};
