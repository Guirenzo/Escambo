import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import type { WalletRange } from './wallet.period';

export interface WalletRow extends RowDataPacket {
  id: number;
  user_id: number;
  balance: string;
  balance_pending: string;
  currency: string;
  credits_balance: string;
  credits_pending: string;
}

export interface WalletTxRow extends RowDataPacket {
  id: number;
  amount: string;
  pending_delta: string;
  balance_after: string;
  pending_after: string;
  reason: string;
  contract_id: number | null;
  payment_id: number | null;
  withdrawal_id: number | null;
  created_at: Date;
}

export const walletRepository = {
  /** Em autocommit: nunca chamar enquanto segura uma conexão/transação de dinheiro. */
  async ensure(userId: number): Promise<void> {
    await pool.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
      userId,
    });
  },

  /** Consulta sem criar carteira nem alterar os saldos (RN-007). */
  async findByUserId(userId: number): Promise<WalletRow | undefined> {
    const [rows] = await pool.query<WalletRow[]>(
      `SELECT id, user_id, balance, balance_pending, currency, credits_balance, credits_pending
         FROM wallets WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  /** Extrato de R$, do mais novo ao mais antigo; o período (RF-047) é [from, to) em UTC. */
  async listTransactions(
    userId: number,
    limit: number,
    offset: number,
    range: WalletRange = {},
  ): Promise<WalletTxRow[]> {
    const params: Record<string, number | Date> = { userId };
    let period = '';
    if (range.from) {
      period += ' AND created_at >= :from';
      params.from = range.from;
    }
    if (range.to) {
      period += ' AND created_at < :to';
      params.to = range.to;
    }
    const [rows] = await pool.query<WalletTxRow[]>(
      `SELECT id, amount, pending_delta, balance_after, pending_after, reason,
              contract_id, payment_id, withdrawal_id, created_at
         FROM wallet_transactions
        WHERE user_id = :userId${period}
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return rows;
  },

  /** Garante que o usuário tem carteira (uma por usuário) e a retorna. */
  async getOrCreate(userId: number): Promise<WalletRow> {
    await this.ensure(userId);
    const [rows] = await pool.query<WalletRow[]>(
      `SELECT id, user_id, balance, balance_pending, currency, credits_balance, credits_pending
         FROM wallets WHERE user_id = :userId LIMIT 1`,
      { userId },
    );
    return rows[0]!;
  },
};
