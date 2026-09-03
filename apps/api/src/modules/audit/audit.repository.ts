import type { ResultSetHeader } from 'mysql2';
import { pool } from '../../config/db';

export const auditRepository = {
  async record(d: {
    userId: number | null;
    action: string;
    entityType: string | null;
    entityId: number | null;
    oldValue: string | null;
    newValue: string | null;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO audit_logs
         (user_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
       VALUES (:userId, :action, :entityType, :entityId, :oldValue, :newValue, :ip, :userAgent)`,
      d,
    );
  },
};
