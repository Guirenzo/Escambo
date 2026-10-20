import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { CREDIT_EARNING_REASONS, EARNING_REASONS, reasonList } from './wallet.earnings';
import { rangeFilter, type WalletRange } from './wallet.period';

/**
 * Leituras dos ganhos (RF-082). Só leitura do ledger: nenhuma linha é escrita nem alterada aqui.
 * O período é [from, to) em UTC, já convertido do fuso da conta.
 */

export interface EarningTxRow extends RowDataPacket {
  id: number;
  amount: string;
  reason: string;
  contract_id: number | null;
  created_at: Date;
}

const MONEY = reasonList(EARNING_REASONS);
const CREDITS = reasonList(CREDIT_EARNING_REASONS);

export const earningsRepository = {
  /** Linhas de ganho em R$ do usuário no período (liberação e torna), da mais antiga à mais nova. */
  async moneyEntries(userId: number, range: WalletRange): Promise<EarningTxRow[]> {
    const period = rangeFilter(range);
    const [rows] = await pool.query<EarningTxRow[]>(
      `SELECT id, amount, reason, contract_id, created_at
         FROM wallet_transactions
        WHERE user_id = :userId AND reason IN ${MONEY} AND amount > 0${period.sql}
        ORDER BY id ASC`,
      { userId, ...period.params },
    );
    return rows;
  },

  /** Créditos no período: soma do total que entrou e saiu do freelancer e as contratações aceitas. */
  async creditTotals(
    userId: number,
    range: WalletRange,
  ): Promise<{ total: number; contracts: number }> {
    const period = rangeFilter(range);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COUNT(DISTINCT CASE WHEN reason = 'escrow_in' THEN contract_id END) AS contracts
         FROM credit_transactions
        WHERE user_id = :userId AND reason IN ${CREDITS}${period.sql}`,
      { userId, ...period.params },
    );
    return { total: Number(rows[0]?.total ?? 0), contracts: Number(rows[0]?.contracts ?? 0) };
  },

  /** Já recebeu alguma vez (em R$ ou em créditos), em qualquer data. */
  async hasEarnings(userId: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT EXISTS(SELECT 1 FROM wallet_transactions
                      WHERE user_id = :userId AND reason IN ${MONEY} AND amount > 0)
           OR EXISTS(SELECT 1 FROM credit_transactions
                      WHERE user_id = :userId AND reason = 'escrow_in') AS has_earnings`,
      { userId },
    );
    return Number(rows[0]?.has_earnings ?? 0) === 1;
  },
};
