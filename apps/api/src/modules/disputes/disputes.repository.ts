import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface DisputeRow extends RowDataPacket {
  id: number;
  ulid: string;
  contract_id: number;
  opened_by: number;
  reason: string;
  description: string;
  status: string;
  resolution: string | null;
  refund_percentage: number | null;
  created_at: Date;
}

const OPEN_STATUSES = "('open', 'under_review', 'awaiting_parties')";
const DISPUTABLE = "('accepted', 'in_progress', 'delivered', 'revision_requested')";

export const disputesRepository = {
  /** Abre a disputa e coloca o contrato em 'disputed' (bloqueia o escrow — RN-038), atômico. */
  async create(d: {
    ulid: string;
    contractId: number;
    openedBy: number;
    reason: string;
    description: string;
  }): Promise<number | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE contracts SET status = 'disputed'
          WHERE id = :contractId AND status IN ${DISPUTABLE}`,
        { contractId: d.contractId },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return null;
      }
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO disputes (ulid, contract_id, opened_by, reason, description)
         VALUES (:ulid, :contractId, :openedBy, :reason, :description)`,
        d,
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:contractId, :openedBy, NULL, 'disputed', 'Disputa aberta')`,
        { contractId: d.contractId, openedBy: d.openedBy },
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

  async findById(id: number): Promise<DisputeRow | undefined> {
    const [rows] = await pool.query<DisputeRow[]>(`SELECT * FROM disputes WHERE id = :id LIMIT 1`, {
      id,
    });
    return rows[0];
  },

  async listForUser(userId: number): Promise<DisputeRow[]> {
    const [rows] = await pool.query<DisputeRow[]>(
      `SELECT d.* FROM disputes d
         JOIN contracts c ON c.id = d.contract_id
        WHERE c.client_id = :userId OR c.freelancer_id = :userId
        ORDER BY d.id DESC`,
      { userId },
    );
    return rows;
  },

  async listOpen(): Promise<DisputeRow[]> {
    const [rows] = await pool.query<DisputeRow[]>(
      `SELECT * FROM disputes WHERE status IN ${OPEN_STATUSES} ORDER BY id ASC`,
    );
    return rows;
  },

  /**
   * Resolve a disputa aplicando a decisão de escrow em UMA transação (RN-063 / RNF-038):
   * atualiza a disputa, o contrato, a carteira do freelancer e grava histórico + admin_action.
   */
  async resolve(p: {
    disputeId: number;
    adminId: number;
    contractId: number;
    freelancerId: number;
    escrowNet: number;
    releaseToFreelancer: number;
    contractFinalStatus: 'completed' | 'cancelled';
    resolution: string;
    refundPercentage: number | null;
    note: string | null;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE disputes
            SET status = 'resolved', resolution = :resolution, refund_percentage = :refundPercentage,
                resolved_by = :adminId, resolution_note = :note, resolved_at = NOW()
          WHERE id = :disputeId AND status <> 'resolved'`,
        {
          resolution: p.resolution,
          refundPercentage: p.refundPercentage,
          adminId: p.adminId,
          note: p.note,
          disputeId: p.disputeId,
        },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return false;
      }

      const tsColumn = p.contractFinalStatus === 'completed' ? 'completed_at' : 'cancelled_at';
      await conn.query<ResultSetHeader>(
        `UPDATE contracts SET status = :status, ${tsColumn} = NOW() WHERE id = :contractId`,
        { status: p.contractFinalStatus, contractId: p.contractId },
      );

      if (p.escrowNet > 0) {
        await conn.query<ResultSetHeader>(
          `UPDATE wallets
              SET balance_pending = balance_pending - :net, balance = balance + :release
            WHERE user_id = :freelancerId AND balance_pending >= :net`,
          { net: p.escrowNet, release: p.releaseToFreelancer, freelancerId: p.freelancerId },
        );
      }

      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:contractId, :adminId, 'disputed', :status, :note)`,
        { contractId: p.contractId, adminId: p.adminId, status: p.contractFinalStatus, note: `Disputa resolvida: ${p.resolution}` },
      );

      await conn.query<ResultSetHeader>(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id, description)
         VALUES (:adminId, 'dispute_resolved', 'dispute', :disputeId, :description)`,
        { adminId: p.adminId, disputeId: p.disputeId, description: `resolution=${p.resolution}` },
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
};
