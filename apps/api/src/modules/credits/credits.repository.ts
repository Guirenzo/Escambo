import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';
import { rangeFilter, type WalletRange } from '../wallet/wallet.period';
import { walletRepository } from '../wallet/wallet.repository';
import { lockWalletUsers } from '../wallet/wallet.locks';

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
  /**
   * Leitura sem trava: o bônus de boas-vindas já saiu? É o atalho do caminho comum (toda leitura
   * da carteira); a conferência que vale, sob a trava, é a do grantWelcomeIfNew.
   */
  async hasWelcome(userId: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM credit_transactions WHERE user_id = :userId AND reason = 'welcome' LIMIT 1`,
      { userId },
    );
    return rows.length > 0;
  },

  async grantWelcomeIfNew(userId: number, bonus: number): Promise<void> {
    if (bonus <= 0) return;
    await walletRepository.ensure(userId);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await lockWalletUsers(conn, [userId]);
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

  /** Extrato de créditos, do mais novo ao mais antigo; o período (RF-047) é [from, to) em UTC. */
  async listTransactions(
    userId: number,
    limit: number,
    offset: number,
    range: WalletRange = {},
  ): Promise<CreditTxRow[]> {
    const period = rangeFilter(range);
    const [rows] = await pool.query<CreditTxRow[]>(
      `SELECT id, user_id, amount, balance_after, reason, contract_id, created_at
         FROM credit_transactions
        WHERE user_id = :userId${period.sql}
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId, ...period.params },
    );
    return rows;
  },
};
