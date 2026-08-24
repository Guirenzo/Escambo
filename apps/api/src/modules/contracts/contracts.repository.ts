import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface ContractRow extends RowDataPacket {
  id: number;
  ulid: string;
  client_id: number;
  freelancer_id: number;
  service_id: number | null;
  title: string;
  description: string;
  price: string;
  platform_fee: string;
  freelancer_net: string;
  status: string;
  deadline_at: Date | null;
  accepted_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
}

export interface HistoryRow extends RowDataPacket {
  old_status: string | null;
  new_status: string;
  note: string | null;
  created_at: Date;
}

export const contractsRepository = {
  async create(data: {
    ulid: string;
    clientId: number;
    freelancerId: number;
    serviceId: number | null;
    title: string;
    description: string;
    price: number;
    platformFee: number;
    freelancerNet: number;
    deadlineAt: string | null;
  }): Promise<number> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO contracts
           (ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, deadline_at)
         VALUES
           (:ulid, :clientId, :freelancerId, :serviceId, :title, :description, :price, :platformFee, :freelancerNet, :deadlineAt)`,
        data,
      );
      const id = res.insertId;
      // status inicial no histórico (RN-022): NULL -> pending
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, NULL, 'pending', 'Proposta enviada')`,
        { id, changedBy: data.clientId },
      );
      await conn.commit();
      return id;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async findById(id: number): Promise<ContractRow | undefined> {
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT * FROM contracts WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<ContractRow[]> {
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT * FROM contracts
        WHERE client_id = :userId OR freelancer_id = :userId
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  async listHistory(contractId: number): Promise<HistoryRow[]> {
    const [rows] = await pool.query<HistoryRow[]>(
      `SELECT old_status, new_status, note, created_at
         FROM contract_status_history
        WHERE contract_id = :contractId
        ORDER BY id ASC`,
      { contractId },
    );
    return rows;
  },

  /**
   * Transição de status ATÔMICA com concorrência otimista:
   * o UPDATE só afeta a linha se o status ainda for `from` (evita corrida),
   * e o histórico é gravado na mesma transação (RNF-038 / RN-022).
   * Retorna false se a transição não se aplicou (status já mudou).
   */
  async transition(params: {
    id: number;
    changedBy: number;
    from: string;
    to: string;
    note: string | null;
    timestampColumn?: 'accepted_at' | 'completed_at' | 'cancelled_at';
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const tsSet = params.timestampColumn ? `, ${params.timestampColumn} = NOW()` : '';
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts SET status = :to${tsSet} WHERE id = :id AND status = :from`,
        { to: params.to, id: params.id, from: params.from },
      );

      if (res.affectedRows === 0) {
        await conn.rollback();
        return false;
      }

      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, :from, :to, :note)`,
        { id: params.id, changedBy: params.changedBy, from: params.from, to: params.to, note: params.note },
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

  /** Registra a entrega e transiciona para `delivered` na mesma transação. */
  async deliver(params: {
    id: number;
    changedBy: number;
    from: string;
    message: string;
    files: string[] | null;
  }): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE contracts SET status = 'delivered' WHERE id = :id AND status = :from`,
        { id: params.id, from: params.from },
      );
      if (res.affectedRows === 0) {
        await conn.rollback();
        return false;
      }

      await conn.query<ResultSetHeader>(
        `INSERT INTO deliveries (contract_id, message, files) VALUES (:id, :message, :files)`,
        { id: params.id, message: params.message, files: params.files ? JSON.stringify(params.files) : null },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, :from, 'delivered', NULL)`,
        { id: params.id, changedBy: params.changedBy, from: params.from },
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
