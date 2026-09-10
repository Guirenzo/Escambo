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
  user_id: number;
  reason: string | null;
  status: string;
  admin_note: string | null;
  processed_at: Date | null;
  created_at: Date;
}

/** Solicitação de exclusão com o titular e o que ainda o prende à plataforma. */
export interface AdminDeletionRow extends DeletionRow {
  user_ulid: string;
  user_email: string;
  user_name: string | null;
  active_contracts: number;
  balance: string;
  balance_pending: string;
}

export interface ExportRow extends RowDataPacket {
  id: number;
  user_id: number;
  status: string;
  file_url: string | null;
  expires_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
}

/** Contratações que ainda prendem o titular (dinheiro retido ou trabalho em andamento). */
const ACTIVE_CONTRACT_STATUSES = `('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')`;

const DELETION_COLS = `d.id, d.user_id, d.reason, d.status, d.admin_note, d.processed_at, d.created_at`;
const EXPORT_COLS = `id, user_id, status, file_url, expires_at, processed_at, created_at`;

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

  // ---------- exclusão ----------

  async findActiveDeletion(userId: number): Promise<DeletionRow | undefined> {
    const [rows] = await pool.query<DeletionRow[]>(
      `SELECT ${DELETION_COLS} FROM data_deletion_requests d
        WHERE d.user_id = :userId AND d.status IN ('pending', 'processing') LIMIT 1`,
      { userId },
    );
    return rows[0];
  },

  async findDeletion(id: number): Promise<DeletionRow | undefined> {
    const [rows] = await pool.query<DeletionRow[]>(
      `SELECT ${DELETION_COLS} FROM data_deletion_requests d WHERE d.id = :id LIMIT 1`,
      { id },
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
      `SELECT ${DELETION_COLS} FROM data_deletion_requests d
        WHERE d.user_id = :userId ORDER BY d.id DESC`,
      { userId },
    );
    return rows;
  },

  /** O que impede a exclusão agora: contratações abertas e dinheiro na carteira. */
  async deletionBlockers(
    userId: number,
  ): Promise<{ activeContracts: number; balance: number; balancePending: number }> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM contracts
           WHERE (client_id = :userId OR freelancer_id = :userId)
             AND status IN ${ACTIVE_CONTRACT_STATUSES}) AS active_contracts,
         (SELECT COALESCE(balance, 0) FROM wallets WHERE user_id = :userId) AS balance,
         (SELECT COALESCE(balance_pending, 0) FROM wallets WHERE user_id = :userId) AS balance_pending`,
      { userId },
    );
    const r = rows[0]!;
    return {
      activeContracts: Number(r.active_contracts),
      balance: Number(r.balance ?? 0),
      balancePending: Number(r.balance_pending ?? 0),
    };
  },

  async listDeletionsForAdmin(statuses: string[], limit: number): Promise<AdminDeletionRow[]> {
    if (statuses.length === 0) return [];
    const [rows] = await pool.query<AdminDeletionRow[]>(
      `SELECT ${DELETION_COLS}, u.ulid AS user_ulid, u.email AS user_email,
              COALESCE(fp.full_name, cp.full_name) AS user_name,
              (SELECT COUNT(*) FROM contracts c
                WHERE (c.client_id = d.user_id OR c.freelancer_id = d.user_id)
                  AND c.status IN ${ACTIVE_CONTRACT_STATUSES}) AS active_contracts,
              COALESCE(w.balance, 0) AS balance,
              COALESCE(w.balance_pending, 0) AS balance_pending
         FROM data_deletion_requests d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN profiles_freelancer fp ON fp.user_id = d.user_id
         LEFT JOIN profiles_client cp ON cp.user_id = d.user_id
         LEFT JOIN wallets w ON w.user_id = d.user_id
        WHERE d.status IN (:statuses)
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT ${limit}`,
      { statuses },
    );
    return rows;
  },

  async rejectDeletion(id: number, adminId: number, note: string | null): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE data_deletion_requests
          SET status = 'rejected', admin_note = :note, processed_by = :adminId, processed_at = NOW()
        WHERE id = :id AND status IN ('pending', 'processing')`,
      { id, adminId, note },
    );
    return res.affectedRows > 0;
  },

  /**
   * Conclui a exclusão ANONIMIZANDO o titular em uma transação: a conta deixa de ser
   * identificável (e-mail, telefone, senha, perfis, serviços, favoritos, buscas salvas,
   * notificações), mas contratações, mensagens, avaliações e extratos ficam, sem nome, para
   * obrigações fiscais e segurança (Política de Privacidade, seção 4).
   */
  async completeDeletion(id: number, userId: number, adminId: number): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE data_deletion_requests
            SET status = 'completed', processed_by = :adminId, processed_at = NOW()
          WHERE id = :id AND user_id = :userId AND status IN ('pending', 'processing')`,
        { id, userId, adminId },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE users
            SET email = CONCAT('removido+', id, '@anon.escambo.invalid'),
                phone = NULL, password_hash = NULL, status = 'banned', deleted_at = NOW()
          WHERE id = :userId`,
        { userId },
      );
      await conn.query<ResultSetHeader>(
        `UPDATE profiles_freelancer
            SET full_name = 'Usuário removido', avatar_url = NULL, bio = NULL, headline = NULL,
                city = NULL, state = NULL, latitude = NULL, longitude = NULL, is_available = 0
          WHERE user_id = :userId`,
        { userId },
      );
      await conn.query<ResultSetHeader>(
        `UPDATE profiles_client
            SET full_name = 'Usuário removido', avatar_url = NULL, bio = NULL,
                city = NULL, state = NULL, latitude = NULL, longitude = NULL
          WHERE user_id = :userId`,
        { userId },
      );
      await conn.query<ResultSetHeader>(
        `UPDATE services SET is_active = 0, deleted_at = COALESCE(deleted_at, NOW()) WHERE user_id = :userId`,
        { userId },
      );
      await conn.query<ResultSetHeader>(`DELETE FROM favorites WHERE user_id = :userId`, {
        userId,
      });
      await conn.query<ResultSetHeader>(`DELETE FROM saved_searches WHERE user_id = :userId`, {
        userId,
      });
      await conn.query<ResultSetHeader>(`DELETE FROM notifications WHERE user_id = :userId`, {
        userId,
      });
      await conn.query<ResultSetHeader>(
        `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL`,
        { userId },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id, description)
         VALUES (:adminId, 'lgpd_deletion_completed', 'user', :userId, 'conta anonimizada a pedido do titular')`,
        { adminId, userId },
      );
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  // ---------- exportação ----------

  async createExport(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO data_export_requests (user_id) VALUES (:userId)`,
      { userId },
    );
    return res.insertId;
  },

  async findExport(id: number): Promise<ExportRow | undefined> {
    const [rows] = await pool.query<ExportRow[]>(
      `SELECT ${EXPORT_COLS} FROM data_export_requests WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listExports(userId: number): Promise<ExportRow[]> {
    const [rows] = await pool.query<ExportRow[]>(
      `SELECT ${EXPORT_COLS} FROM data_export_requests
        WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },

  async markExportReady(id: number, fileUrl: string, expiresAt: Date): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE data_export_requests
          SET status = 'ready', file_url = :fileUrl, expires_at = :expiresAt, processed_at = NOW()
        WHERE id = :id`,
      { id, fileUrl, expiresAt },
    );
  },

  async markExportFailed(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE data_export_requests SET status = 'failed', processed_at = NOW() WHERE id = :id`,
      { id },
    );
  },

  async markExportDownloaded(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE data_export_requests SET status = 'downloaded' WHERE id = :id AND status = 'ready'`,
      { id },
    );
  },

  /** Exportações vencidas ainda com arquivo (job de expiração). */
  async listExpiredExports(): Promise<ExportRow[]> {
    const [rows] = await pool.query<ExportRow[]>(
      `SELECT ${EXPORT_COLS} FROM data_export_requests
        WHERE status IN ('ready', 'downloaded') AND expires_at IS NOT NULL AND expires_at < NOW()
        LIMIT 200`,
    );
    return rows;
  },

  async markExportExpired(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE data_export_requests SET status = 'expired', file_url = NULL WHERE id = :id`,
      { id },
    );
  },
};
