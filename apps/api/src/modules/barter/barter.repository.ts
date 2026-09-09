import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';
import { applyWalletEffect } from '../wallet/wallet.ledger';

export interface BarterRow extends RowDataPacket {
  id: number;
  ulid: string;
  proposer_id: number;
  receiver_id: number;
  offered_service_id: number | null;
  requested_service_id: number | null;
  offered_title?: string | null;
  requested_title?: string | null;
  offered_description: string | null;
  requested_description: string | null;
  estimated_value_offered: string;
  estimated_value_requested: string;
  cash_difference: string;
  cash_payer_id: number | null;
  platform_fee: string;
  torna_status: string;
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

/** Reserva da torna: sai do disponível do pagador e fica retida até a troca concluir. */
export interface TornaHold {
  userId: number;
  amount: number;
}

export type AcceptResult =
  | { ok: true; contractOfferedId: number; contractRequestedId: number }
  | { ok: false; reason: 'conflict' | 'insufficient_balance' };

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

/** Reserva a torna na carteira do pagador (balance → balance_pending) e marca 'held'. */
async function holdTorna(
  conn: PoolConnection,
  agreementId: number,
  hold: TornaHold,
): Promise<boolean> {
  await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
    userId: hold.userId,
  });
  const ok = await applyWalletEffect(conn, {
    userId: hold.userId,
    balanceDelta: -hold.amount,
    pendingDelta: hold.amount,
    reason: 'barter_hold',
  });
  if (!ok) return false;
  await conn.query<ResultSetHeader>(
    `UPDATE barter_agreements SET torna_status = 'held' WHERE id = :id`,
    { id: agreementId },
  );
  return true;
}

/** Devolve a torna reservada ao pagador (só se estiver 'held') e marca 'refunded'. */
async function refundTorna(conn: PoolConnection, row: BarterRow): Promise<boolean> {
  if (row.torna_status !== 'held' || !row.cash_payer_id) return true;
  const amount = Number(row.cash_difference);
  const ok = await applyWalletEffect(conn, {
    userId: row.cash_payer_id,
    balanceDelta: amount,
    pendingDelta: -amount,
    reason: 'refund',
  });
  if (!ok) return false;
  await conn.query<ResultSetHeader>(
    `UPDATE barter_agreements SET torna_status = 'refunded' WHERE id = :id`,
    { id: row.id },
  );
  return true;
}

/** Acordo + títulos dos serviços envolvidos (LEFT JOIN: serviço pode ter sido removido). */
const WITH_TITLES = `SELECT b.*, so.title AS offered_title, sr.title AS requested_title
         FROM barter_agreements b
         LEFT JOIN services so ON so.id = b.offered_service_id
         LEFT JOIN services sr ON sr.id = b.requested_service_id`;

async function lockRow(conn: PoolConnection, id: number): Promise<BarterRow | undefined> {
  const [rows] = await conn.query<BarterRow[]>(
    `SELECT * FROM barter_agreements WHERE id = :id FOR UPDATE`,
    { id },
  );
  return rows[0];
}

export const barterRepository = {
  /**
   * Cria a proposta; quando o proponente é quem paga a torna, reserva o valor na mesma
   * transação (retorna null se não há saldo — nada é criado).
   */
  async create(
    data: {
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
      tornaStatus: 'none' | 'pending';
    },
    hold: TornaHold | null,
  ): Promise<number | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO barter_agreements
           (ulid, proposer_id, receiver_id, offered_service_id, requested_service_id,
            offered_description, requested_description, estimated_value_offered, estimated_value_requested,
            cash_difference, cash_payer_id, platform_fee, torna_status)
         VALUES
           (:ulid, :proposerId, :receiverId, :offeredServiceId, :requestedServiceId,
            :offeredDescription, :requestedDescription, :estimatedValueOffered, :estimatedValueRequested,
            :cashDifference, :cashPayerId, :platformFee, :tornaStatus)`,
        data,
      );
      const id = res.insertId;
      if (hold && !(await holdTorna(conn, id, hold))) {
        await conn.rollback();
        return null;
      }
      await conn.commit();
      return id;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async findById(id: number): Promise<BarterRow | undefined> {
    const [rows] = await pool.query<BarterRow[]>(`${WITH_TITLES} WHERE b.id = :id LIMIT 1`, {
      id,
    });
    return rows[0];
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<BarterRow[]> {
    const [rows] = await pool.query<BarterRow[]>(
      `${WITH_TITLES}
        WHERE b.proposer_id = :userId OR b.receiver_id = :userId
        ORDER BY b.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  /**
   * Recusa/cancela uma troca ainda 'proposed' e devolve a torna se estava reservada —
   * tudo numa transação. Retorna false se o status já mudou.
   */
  async setStatusFromProposed(id: number, to: 'rejected' | 'cancelled'): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const row = await lockRow(conn, id);
      if (!row || row.status !== 'proposed') {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements SET status = :to WHERE id = :id`,
        { to, id },
      );
      if (!(await refundTorna(conn, row))) {
        await conn.rollback();
        return false;
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

  /**
   * Aceita a troca: gera os 2 contratos recíprocos, reserva a torna (quando ainda pendente)
   * e ativa a troca — tudo em UMA transação (RNF-038 / RN-066 / RN-067).
   */
  async accept(params: {
    agreementId: number;
    acceptorId: number;
    contractOffered: ContractSpec;
    contractRequested: ContractSpec;
    /** Reserva a fazer agora (torna ainda 'pending'); null quando já reservada ou sem torna. */
    hold: TornaHold | null;
  }): Promise<AcceptResult> {
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
        return { ok: false, reason: 'conflict' };
      }

      if (params.hold && !(await holdTorna(conn, params.agreementId, params.hold))) {
        await conn.rollback();
        return { ok: false, reason: 'insufficient_balance' };
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

      await conn.commit();
      return { ok: true, contractOfferedId: offeredId, contractRequestedId: requestedId };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * Conclui a troca (os dois contratos aprovados) e LIQUIDA a torna reservada: o pagador deixa
   * de ter o valor retido, o outro lado recebe torna − taxa no disponível, e a plataforma
   * fica com a taxa. Uma transação; false se a troca já não estava ativa.
   */
  async completeAndRelease(id: number): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const row = await lockRow(conn, id);
      if (!row || row.status !== 'active') {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements SET status = 'completed', completed_at = NOW() WHERE id = :id`,
        { id },
      );
      if (row.torna_status === 'held' && row.cash_payer_id) {
        const torna = Number(row.cash_difference);
        const fee = Number(row.platform_fee);
        const receiverId =
          row.cash_payer_id === row.proposer_id ? row.receiver_id : row.proposer_id;
        const paid = await applyWalletEffect(conn, {
          userId: row.cash_payer_id,
          balanceDelta: 0,
          pendingDelta: -torna,
          reason: 'barter_payment',
        });
        await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
          userId: receiverId,
        });
        const received = await applyWalletEffect(conn, {
          userId: receiverId,
          balanceDelta: Math.max(0, Math.round((torna - fee) * 100) / 100),
          pendingDelta: 0,
          reason: 'barter_in',
        });
        if (!paid || !received) {
          await conn.rollback();
          return false;
        }
        await conn.query<ResultSetHeader>(
          `UPDATE barter_agreements SET torna_status = 'paid' WHERE id = :id`,
          { id },
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

  /**
   * Um dos contratos foi cancelado: a troca entra em disputa (RN-067) e a torna reservada volta
   * ao pagador — o dinheiro não fica preso enquanto a troca está quebrada.
   */
  async disputeAndRefund(id: number): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const row = await lockRow(conn, id);
      if (!row || row.status !== 'active') {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE barter_agreements SET status = 'disputed' WHERE id = :id`,
        { id },
      );
      if (!(await refundTorna(conn, row))) {
        await conn.rollback();
        return false;
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
