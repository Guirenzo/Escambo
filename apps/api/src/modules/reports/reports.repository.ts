import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface ContentReportRow extends RowDataPacket {
  id: number;
  target_type: string;
  target_id: number;
  reason: string;
  status: string;
  created_at: Date;
}

export const reportsRepository = {
  async create(d: {
    reporterId: number;
    targetType: string;
    targetId: number;
    reason: string;
    description: string | null;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO content_reports (reporter_id, target_type, target_id, reason, description)
       VALUES (:reporterId, :targetType, :targetId, :reason, :description)`,
      d,
    );
    return res.insertId;
  },

  async listForReporter(reporterId: number): Promise<ContentReportRow[]> {
    const [rows] = await pool.query<ContentReportRow[]>(
      `SELECT id, target_type, target_id, reason, status, created_at FROM content_reports
        WHERE reporter_id = :reporterId ORDER BY id DESC`,
      { reporterId },
    );
    return rows;
  },
};
