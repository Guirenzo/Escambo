import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface WithdrawalRow extends RowDataPacket {
  id: number;
  amount: string;
  status: string;
  pix_key: string | null;
  bank_account: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export const withdrawalRepository = {
  /**
   * Cria o saque debitando o saldo disponível na MESMA transação (RNF-038).
   * A guarda `balance >= amount` impede saldo negativo; retorna null se insuficiente.
   */
  async createIfSufficient(params: {
    userId: number;
    amount: number;
    pixKey: string | null;
    bankName: string | null;
    bankAgency: string | null;
    bankAccount: string | null;
  }): Promise<number | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
        userId: params.userId,
      });
      const [wallets] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM wallets WHERE user_id = :userId LIMIT 1`,
        { userId: params.userId },
      );
      const walletId = Number(wallets[0]?.id);

      const [debit] = await conn.query<ResultSetHeader>(
        `UPDATE wallets SET balance = balance - :amount
          WHERE user_id = :userId AND balance >= :amount`,
        { amount: params.amount, userId: params.userId },
      );
      if (debit.affectedRows === 0) {
        await conn.rollback();
        return null; // saldo insuficiente
      }

      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO withdrawals
           (user_id, wallet_id, amount, bank_name, bank_agency, bank_account, pix_key)
         VALUES
           (:userId, :walletId, :amount, :bankName, :bankAgency, :bankAccount, :pixKey)`,
        {
          userId: params.userId,
          walletId,
          amount: params.amount,
          bankName: params.bankName,
          bankAgency: params.bankAgency,
          bankAccount: params.bankAccount,
          pixKey: params.pixKey,
        },
      );

      await conn.commit();
      return res.insertId;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async findById(id: number): Promise<WithdrawalRow | undefined> {
    const [rows] = await pool.query<WithdrawalRow[]>(
      `SELECT id, amount, status, pix_key, bank_account, created_at, processed_at
         FROM withdrawals WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<WithdrawalRow[]> {
    const [rows] = await pool.query<WithdrawalRow[]>(
      `SELECT id, amount, status, pix_key, bank_account, created_at, processed_at
         FROM withdrawals WHERE user_id = :userId
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },
};
