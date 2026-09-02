import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';

export interface CreditTxRow extends RowDataPacket {
  id: number;
  user_id: number;
  amount: string;
  balance_after: string;
  reason: string;
  contract_id: number | null;
  created_at: Date;
}

export const creditsRepository = {
  /**
   * Concede o bônus de boas-vindas uma única vez (idempotente). Serializa por
   * usuário com SELECT ... FOR UPDATE para não conceder em dobro sob concorrência.
   */
  async grantWelcomeIfNew(userId: number, bonus: number): Promise<void> {
    if (bonus <= 0) return;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
        userId,
      });
      // Lock da carteira do usuário (serializa o cheque + concessão).
      await conn.query<RowDataPacket[]>(
        `SELECT credits_balance FROM wallets WHERE user_id = :userId FOR UPDATE`,
        { userId },
      );
      const [already] = await conn.query<RowDataPacket[]>(
        `SELECT 1 FROM credit_transactions WHERE user_id = :userId AND reason = 'welcome' LIMIT 1`,
        { userId },
      );
      if (already.length > 0) {
        await conn.rollback();
        return;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE wallets SET credits_balance = credits_balance + :bonus WHERE user_id = :userId`,
        { bonus, userId },
      );
      const [w] = await conn.query<RowDataPacket[]>(
        `SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId`,
        { userId },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, reason)
         VALUES (:userId, :bonus, :after, 'welcome')`,
        { userId, bonus, after: Number(w[0]!.total) },
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async listTransactions(userId: number, limit: number, offset: number): Promise<CreditTxRow[]> {
    const [rows] = await pool.query<CreditTxRow[]>(
      `SELECT id, user_id, amount, balance_after, reason, contract_id, created_at
         FROM credit_transactions
        WHERE user_id = :userId
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },
};
