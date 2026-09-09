import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface MetricsRow extends RowDataPacket {
  users: number;
  freelancers: number;
  contracts: number;
  completed_contracts: number;
  open_disputes: number;
  platform_fees: string;
  in_escrow: string;
  pending_withdrawals: number;
  pending_withdrawals_amount: string;
  deposits_total: string;
  users_balance: string;
}

export const adminRepository = {
  async setUserStatus(ulid: string, status: string): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE users SET status = :status WHERE ulid = :ulid`,
      { status, ulid },
    );
    return res.affectedRows > 0;
  },

  async recordAction(
    adminId: number,
    action: string,
    targetType: string | null,
    targetId: number | null,
    description: string | null,
  ): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, description)
       VALUES (:adminId, :action, :targetType, :targetId, :description)`,
      { adminId, action, targetType, targetId, description },
    );
  },

  async metrics(): Promise<MetricsRow> {
    const [rows] = await pool.query<MetricsRow[]>(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM users WHERE role = 'freelancer') AS freelancers,
         (SELECT COUNT(*) FROM contracts) AS contracts,
         (SELECT COUNT(*) FROM contracts WHERE status = 'completed') AS completed_contracts,
         (SELECT COUNT(*) FROM disputes WHERE status IN ('open','under_review','awaiting_parties')) AS open_disputes,
         (SELECT COALESCE(SUM(platform_fee), 0) FROM contracts WHERE status = 'completed') AS platform_fees,
         (SELECT COALESCE(SUM(balance_pending), 0) FROM wallets) AS in_escrow,
         (SELECT COUNT(*) FROM withdrawals WHERE status IN ('requested','processing')) AS pending_withdrawals,
         (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE status IN ('requested','processing')) AS pending_withdrawals_amount,
         (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE kind = 'topup' AND status = 'paid') AS deposits_total,
         (SELECT COALESCE(SUM(balance), 0) FROM wallets) AS users_balance`,
    );
    return rows[0]!;
  },
};
