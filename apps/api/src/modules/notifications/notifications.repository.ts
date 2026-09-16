import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { BrazilTimezone } from '@escambo/types';
import { pool } from '../../config/db';
import { DEFAULT_TIMEZONE } from '../../utils/timezone';

export interface NotificationRow extends RowDataPacket {
  id: number;
  type: string;
  title: string;
  body: string | null;
  data: string | Record<string, unknown> | null;
  is_read: number;
  created_at: Date;
}

/** Usuário que escolheu resumo diário e ainda não recebeu o de hoje. */
export interface DigestUserRow extends RowDataPacket {
  id: number;
  email: string;
  last_digest_at: Date | null;
}

export const notificationsRepository = {
  /** Notificações criadas depois de `since` (as que entram no resumo), em ordem cronológica. */
  async listSince(userId: number, since: Date, limit = 50): Promise<NotificationRow[]> {
    const [rows] = await pool.query<NotificationRow[]>(
      `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications WHERE user_id = :userId AND created_at > :since
        ORDER BY id ASC
        LIMIT ${limit}`,
      { userId, since },
    );
    return rows;
  },

  /**
   * Quem quer resumo diário, está no fuso `zone` (ADR 46), já chegou na própria hora hoje
   * (ADR 42) e ainda não recebeu o resumo deste dia local (`dayStart`, meia-noite no fuso).
   */
  async usersForDigest(
    dayStart: Date,
    hourNow: number,
    defaultHour: number,
    zone: BrazilTimezone,
  ): Promise<DigestUserRow[]> {
    const [rows] = await pool.query<DigestUserRow[]>(
      `SELECT id, email, last_digest_at FROM users
        WHERE email_frequency = 'daily' AND deleted_at IS NULL
          AND COALESCE(timezone, :defaultZone) = :zone
          AND COALESCE(digest_hour, :defaultHour) <= :hourNow
          AND (last_digest_at IS NULL OR last_digest_at < :dayStart)
        ORDER BY id ASC
        LIMIT 500`,
      { dayStart, hourNow, defaultHour, zone, defaultZone: DEFAULT_TIMEZONE },
    );
    return rows;
  },

  /** Marca o resumo de hoje como tratado (enviado, ou sem novidades) — trava de um por dia. */
  async markDigest(userId: number, at: Date): Promise<void> {
    await pool.query<ResultSetHeader>(`UPDATE users SET last_digest_at = :at WHERE id = :userId`, {
      userId,
      at,
    });
  },

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
