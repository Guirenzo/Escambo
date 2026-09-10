import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface OutboxRow extends RowDataPacket {
  id: number;
  user_id: number | null;
  to_email: string;
  subject: string;
  template: string;
  text_body: string;
  status: string;
  provider: string;
  error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

const COLS = `id, user_id, to_email, subject, template, text_body, status, provider, error, sent_at, created_at`;

export const mailRepository = {
  async create(d: {
    userId: number | null;
    to: string;
    subject: string;
    template: string;
    text: string;
    html: string;
    provider: string;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO email_outbox (user_id, to_email, subject, template, text_body, html_body, provider)
       VALUES (:userId, :to, :subject, :template, :text, :html, :provider)`,
      d,
    );
    return res.insertId;
  },

  async markSent(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE email_outbox SET status = 'sent', sent_at = NOW() WHERE id = :id`,
      { id },
    );
  },

  async markFailed(id: number, error: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE email_outbox SET status = 'failed', error = :error WHERE id = :id`,
      { id, error: error.slice(0, 500) },
    );
  },

  /** Caixa de saída (admin): mais recentes primeiro, opcionalmente de um usuário. */
  async listRecent(limit: number, userId: number | null): Promise<OutboxRow[]> {
    const [rows] = await pool.query<OutboxRow[]>(
      `SELECT ${COLS} FROM email_outbox
        WHERE (:userId IS NULL OR user_id = :userId)
        ORDER BY id DESC
        LIMIT ${limit}`,
      { userId },
    );
    return rows;
  },

  /** LGPD: e-mails guardados de um titular anonimizado. */
  async deleteForUser(userId: number): Promise<void> {
    await pool.query<ResultSetHeader>(`DELETE FROM email_outbox WHERE user_id = :userId`, {
      userId,
    });
  },
};
