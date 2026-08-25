import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';

export interface BarterRow extends RowDataPacket {
  id: number;
  ulid: string;
  proposer_id: number;
  receiver_id: number;
  offered_service_id: number | null;
  requested_service_id: number | null;
  offered_description: string | null;
  requested_description: string | null;
  estimated_value_offered: string;
  estimated_value_requested: string;
  cash_difference: string;
  cash_payer_id: number | null;
  platform_fee: string;
  status: string;
  contract_offered_id: number | null;
  contract_requested_id: number | null;
  created_at: Date;
}

interface ContractSpec {
  ulid: string;
  clientId: number;
  freelancerId: number;
  serviceId: number | null;
  title: string;
  description: string;
  price: number;
}

async function insertBarterContract(
  conn: PoolConnection,
  agreementId: number,
  acceptorId: number,
  spec: ContractSpec,
): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO contracts
       (ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, status, payment_mode, barter_agreement_id, accepted_at)
     VALUES
       (:ulid, :clientId, :freelancerId, :serviceId, :title, :description, :price, 0, :price, 'accepted', 'barter', :agreementId, NOW())`,
    { ...spec, agreementId },
  );
  const contractId = res.insertId;
  await conn.query<ResultSetHeader>(
    `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
     VALUES (:contractId, :acceptorId, NULL, 'accepted', 'Contrato gerado pela troca')`,
    { contractId, acceptorId },
  );
  return contractId;
}

export const barterRepository = {
  async create(data: {
    ulid: string;
    proposerId: number;
    receiverId: number;
    offeredServiceId: number | null;
    requestedServiceId: number | null;
    offeredDescription: string | null;
    requestedDescription: string | null;
    estimatedValueOffered: number;
    estimatedValueRequested: number;
    cashDifference: number;
    cashPayerId: number | null;
    platformFee: number;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO barter_agreements
         (ulid, proposer_id, receiver_id, offered_service_id, requested_service_id,
          offered_description, requested_description, estimated_value_offered, estimated_value_requested,
          cash_difference, cash_payer_id, platform_fee)
       VALUES
         (:ulid, :proposerId, :receiverId, :offeredServiceId, :requestedServiceId,
          :offeredDescription, :requestedDescription, :estimatedValueOffered, :estimatedValueRequested,
          :cashDifference, :cashPayerId, :platformFee)`,
      data,
    );
    return res.insertId;
  },

  async findById(id: number): Promise<BarterRow | undefined> {
    const [rows] = await pool.query<BarterRow[]>(
      `SELECT * FROM barter_agreements WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<BarterRow[]> {
    const [rows] = await pool.query<BarterRow[]>(
      `SELECT * FROM barter_agreements
        WHERE proposer_id = :userId OR receiver_id = :userId
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  /** Muda o status apenas se ainda estiver 'proposed' (rejeitar/cancelar). */
  async setStatusFromProposed(id: number, to: 'rejected' | 'cancelled'): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE barter_agreements SET status = :to WHERE id = :id AND status = 'proposed'`,
      { to, id },
    );
    return res.affectedRows > 0;
  },

  /**
   * Aceita a troca: gera os 2 contratos recíprocos, retém a torna em escrow e ativa a troca —
   * tudo em UMA transação (RNF-038 / RN-067). Retorna null se já não estava 'proposed'.
   */
  async accept(params: {
    agreementId: number;
    acceptorId: number;
    contractOffered: ContractSpec;
    contractRequested: ContractSpec;
    torna: { recipientId: number; amount: number } | null;
  }): Promise<{ contractOfferedId: number; contractRequestedId: number } | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements SET status = 'active', accepted_at = NOW()
          WHERE id = :id AND status = 'proposed'`,
        { id: params.agreementId },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return null;
      }

      const offeredId = await insertBarterContract(
        conn,
        params.agreementId,
        params.acceptorId,
        params.contractOffered,
      );
      const requestedId = await insertBarterContract(
        conn,
        params.agreementId,
        params.acceptorId,
        params.contractRequested,
      );

      await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements
            SET contract_offered_id = :offeredId, contract_requested_id = :requestedId
          WHERE id = :id`,
        { offeredId, requestedId, id: params.agreementId },
      );

      if (params.torna && params.torna.amount > 0) {
        await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
          userId: params.torna.recipientId,
        });
        await conn.query<ResultSetHeader>(
          `UPDATE wallets SET balance_pending = balance_pending + :amount WHERE user_id = :userId`,
          { amount: params.torna.amount, userId: params.torna.recipientId },
        );
      }

      await conn.commit();
      return { contractOfferedId: offeredId, contractRequestedId: requestedId };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /** Conclui a troca e libera a torna (pendente -> disponível do recebedor). */
  async completeAndRelease(
    id: number,
    torna: { recipientId: number; amount: number } | null,
  ): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements SET status = 'completed', completed_at = NOW()
          WHERE id = :id AND status = 'active'`,
        { id },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return false;
      }
      if (torna && torna.amount > 0) {
        await conn.query<ResultSetHeader>(
          `UPDATE wallets
              SET balance_pending = balance_pending - :amount, balance = balance + :amount
            WHERE user_id = :userId AND balance_pending >= :amount`,
          { amount: torna.amount, userId: torna.recipientId },
        );
      }
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /** Marca em disputa e estorna a torna retida (removida do pendente do recebedor). */
  async disputeAndRefund(
    id: number,
    torna: { recipientId: number; amount: number } | null,
  ): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements SET status = 'disputed'
          WHERE id = :id AND status = 'active'`,
        { id },
      );
      if (upd.affectedRows === 0) {
        await conn.rollback();
        return false;
      }
      if (torna && torna.amount > 0) {
        await conn.query<ResultSetHeader>(
          `UPDATE wallets SET balance_pending = balance_pending - :amount
            WHERE user_id = :userId AND balance_pending >= :amount`,
          { amount: torna.amount, userId: torna.recipientId },
        );
      }
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
