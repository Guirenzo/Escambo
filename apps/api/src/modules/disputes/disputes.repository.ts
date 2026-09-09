import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { applyWalletEffect } from '../wallet/wallet.ledger';

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
   * atualiza a disputa, o contrato, as carteiras (freelancer E cliente, em R$ ou créditos)
   * e grava histórico + admin_action. Retorna false se a disputa já mudou ou se alguma
   * carteira não comporta o movimento (nada é aplicado).
   */
  async resolve(p: {
    disputeId: number;
    adminId: number;
    contractId: number;
    freelancerId: number;
    clientId: number;
    paymentMode: string;
    /** Quanto está retido para o freelancer (R$ líquido ou créditos). */
    escrowNet: number;
    releaseToFreelancer: number;
    refundToClient: number;
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

      if (p.paymentMode === 'cash' && p.escrowNet > 0) {
        const okF = await applyWalletEffect(conn, {
          userId: p.freelancerId,
          pendingDelta: -p.escrowNet,
          balanceDelta: p.releaseToFreelancer,
          reason: p.releaseToFreelancer > 0 ? 'escrow_release' : 'escrow_refund',
          contractId: p.contractId,
        });
        const okC =
          p.refundToClient <= 0 ||
          (await applyWalletEffect(conn, {
            userId: p.clientId,
            pendingDelta: 0,
            balanceDelta: p.refundToClient,
            reason: 'refund',
            contractId: p.contractId,
          }));
        if (!okF || !okC) {
          await conn.rollback();
          return false;
        }
      } else if (p.paymentMode === 'credits' && p.escrowNet > 0) {
        // Time-bank: mesma decisão, em créditos, com ledger de créditos.
        const moves = [
          {
            userId: p.freelancerId,
            pending: -p.escrowNet,
            balance: p.releaseToFreelancer,
            reason: p.releaseToFreelancer > 0 ? 'escrow_release' : 'escrow_refund',
          },
          { userId: p.clientId, pending: 0, balance: p.refundToClient, reason: 'refund' },
        ].filter((m) => m.pending !== 0 || m.balance !== 0);
        for (const m of moves) {
          const [c] = await conn.query<ResultSetHeader>(
            `UPDATE wallets
                SET credits_pending = credits_pending + :pending,
                    credits_balance = credits_balance + :balance
              WHERE user_id = :userId
                AND credits_pending + :pending >= 0
                AND credits_balance + :balance >= 0`,
            { pending: m.pending, balance: m.balance, userId: m.userId },
          );
          if (c.affectedRows === 0) {
            await conn.rollback();
            return false;
          }
          const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId`,
            { userId: m.userId },
          );
          await conn.query<ResultSetHeader>(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id)
             VALUES (:userId, :amount, :after, :reason, :contractId)`,
            {
              userId: m.userId,
              amount: m.pending + m.balance,
              after: Number(rows[0]!.total),
              reason: m.reason,
              contractId: p.contractId,
            },
          );
        }
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
