import type { UserRole, UserStatus } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface AccessIdentity {
  uid: number;
  sub: string;
  role: string;
}

export interface AccountAccessRow extends RowDataPacket {
  id: number;
  ulid: string;
  role: UserRole;
  status: UserStatus;
  deleted_at: Date | null;
}

export const accountAccessRepository = {
  /** Status e papel atuais, vinculando os dois identificadores assinados da mesma conta. */
  async findCurrent(identity: AccessIdentity): Promise<AccountAccessRow | undefined> {
    const [rows] = await pool.query<AccountAccessRow[]>(
      `SELECT id, ulid, role, status, deleted_at FROM users
        WHERE id = :uid AND ulid = :sub LIMIT 1`,
      { uid: identity.uid, sub: identity.sub },
    );
    return rows[0];
  },
};
