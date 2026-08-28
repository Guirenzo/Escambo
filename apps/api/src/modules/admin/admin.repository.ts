import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface MetricsRow extends RowDataPacket {
  users: number;
  freelancers: number;
  contracts: number;
  completed_contracts: number;
  open_disputes: number;
  platform_fees: string;
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
         (SELECT COALESCE(SUM(platform_fee), 0) FROM contracts WHERE status = 'completed') AS platform_fees`,
    );
    return rows[0]!;
  },
};
