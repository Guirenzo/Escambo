import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

/**
 * Tokens de uso único (verificação de e-mail e redefinição de senha), guardados como hash.
 * `consume` valida e marca como usado na MESMA transação (um link não vale duas vezes, nem em
 * duas requisições simultâneas).
 */

type Purpose = 'verify_email' | 'password_reset';
const TABLE: Record<Purpose, string> = {
  verify_email: 'email_verification_tokens',
  password_reset: 'password_reset_tokens',
};

export const tokensRepository = {
  async create(
    purpose: Purpose,
    userId: number,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO ${TABLE[purpose]} (user_id, token, expires_at) VALUES (:userId, :tokenHash, :expiresAt)`,
      { userId, tokenHash, expiresAt },
    );
  },

  /** Devolve o user_id se o token é válido (existe, não usado, não vencido) e o marca como usado. */
  async consume(purpose: Purpose, tokenHash: string): Promise<number | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT id, user_id FROM ${TABLE[purpose]}
          WHERE token = :tokenHash AND used_at IS NULL AND expires_at > NOW()
          LIMIT 1 FOR UPDATE`,
        { tokenHash },
      );
      const row = rows[0];
      if (!row) {
        await conn.rollback();
        return null;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE ${TABLE[purpose]} SET used_at = NOW() WHERE id = :id`,
        { id: row.id },
      );
      await conn.commit();
      return Number(row.user_id);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /** Invalida os tokens ainda abertos do usuário (novo pedido substitui o anterior). */
  async invalidateOpen(purpose: Purpose, userId: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE ${TABLE[purpose]} SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL`,
      { userId },
    );
  },
};
