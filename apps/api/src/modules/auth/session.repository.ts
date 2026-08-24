import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface SessionRow extends RowDataPacket {
  id: number;
  user_id: number;
  refresh_token: string; // hash SHA-256 do token
  expires_at: Date;
  revoked_at: Date | null;
}

/** Acesso a dados de `user_sessions` (refresh tokens ativos). */
export const sessionRepository = {
  async create(data: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO user_sessions (user_id, refresh_token, ip_address, user_agent, expires_at)
       VALUES (:userId, :tokenHash, :ip, :userAgent, :expiresAt)`,
      data,
    );
  },

  /** Retorna a sessão apenas se o token existe, não foi revogado e não expirou. */
  async findValidByHash(tokenHash: string): Promise<SessionRow | undefined> {
    const [rows] = await pool.query<SessionRow[]>(
      `SELECT id, user_id, refresh_token, expires_at, revoked_at
         FROM user_sessions
        WHERE refresh_token = :tokenHash AND revoked_at IS NULL AND expires_at > NOW()
        LIMIT 1`,
      { tokenHash },
    );
    return rows[0];
  },

  async revokeByHash(tokenHash: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE user_sessions SET revoked_at = NOW()
        WHERE refresh_token = :tokenHash AND revoked_at IS NULL`,
      { tokenHash },
    );
  },

  /** Revoga todas as sessões ativas do usuário (logout global / troca de senha — RN-008). */
  async revokeAllForUser(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE user_sessions SET revoked_at = NOW()
        WHERE user_id = :userId AND revoked_at IS NULL`,
      { userId },
    );
    return res.affectedRows;
  },
};
