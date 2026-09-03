import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface ConsentRow extends RowDataPacket {
  type: string;
  version: string;
  accepted: number;
  created_at: Date;
}

export interface DeletionRow extends RowDataPacket {
  id: number;
  reason: string | null;
  status: string;
  created_at: Date;
}

export interface ExportRow extends RowDataPacket {
  id: number;
  status: string;
  file_url: string | null;
  created_at: Date;
}

export const lgpdRepository = {
  async recordConsent(d: {
    userId: number;
    type: string;
    version: string;
    accepted: boolean;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO lgpd_consents (user_id, type, version, accepted, ip_address, user_agent)
       VALUES (:userId, :type, :version, :accepted, :ip, :userAgent)`,
      d,
    );
  },

  async listConsents(userId: number): Promise<ConsentRow[]> {
    const [rows] = await pool.query<ConsentRow[]>(
      `SELECT type, version, accepted, created_at FROM lgpd_consents
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },

  async findActiveDeletion(userId: number): Promise<DeletionRow | undefined> {
    const [rows] = await pool.query<DeletionRow[]>(
      `SELECT id, reason, status, created_at FROM data_deletion_requests
        WHERE user_id = :userId AND status IN ('pending', 'processing') LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async createDeletion(userId: number, reason: string | null): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO data_deletion_requests (user_id, reason) VALUES (:userId, :reason)`,
      { userId, reason },
    );
    return res.insertId;
  },

  async listDeletions(userId: number): Promise<DeletionRow[]> {
    const [rows] = await pool.query<DeletionRow[]>(
      `SELECT id, reason, status, created_at FROM data_deletion_requests
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },

  async createExport(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO data_export_requests (user_id) VALUES (:userId)`,
      { userId },
    );
    return res.insertId;
  },

  async listExports(userId: number): Promise<ExportRow[]> {
    const [rows] = await pool.query<ExportRow[]>(
      `SELECT id, status, file_url, created_at FROM data_export_requests
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },
};
