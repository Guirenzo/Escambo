import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface WalletRow extends RowDataPacket {
  id: number;
  user_id: number;
  balance: string;
  balance_pending: string;
  currency: string;
  credits_balance: string;
  credits_pending: string;
}

export const walletRepository = {
  /** Garante que o usuário tem carteira (uma por usuário) e a retorna. */
  async getOrCreate(userId: number): Promise<WalletRow> {
    await pool.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
      userId,
    });
    const [rows] = await pool.query<WalletRow[]>(
      `SELECT id, user_id, balance, balance_pending, currency, credits_balance, credits_pending
         FROM wallets WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0]!;
  },
};
