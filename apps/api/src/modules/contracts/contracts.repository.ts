import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { applyWalletEffect, type WalletEffect } from '../wallet/wallet.ledger';
import { milestonesRepository, type MilestoneSpec } from './milestones.repository';

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
  payment_mode: string;
  barter_agreement_id: number | null;
  deadline_at: Date | null;
  accepted_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  has_review?: number; // 1 se o cliente já avaliou (subquery nas consultas de leitura)
  has_milestones?: number; // 1 se o contrato é por marcos (RN-069)
}

export interface HistoryRow extends RowDataPacket {
  old_status: string | null;
  new_status: string;
  note: string | null;
  created_at: Date;
}

/** O cliente já avaliou? Uma avaliação por contrato (RN-042). */
const HAS_REVIEW = `EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id = c.id)`;
/** Contrato por marcos (RN-069)? */
const HAS_MILESTONES = `EXISTS(SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id)`;

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
    paymentMode: 'cash' | 'credits';
    deadlineAt: string | null;
    /**
     * Cash: o valor da proposta sai do saldo disponível do cliente e fica RESERVADO
     * (balance_pending) na mesma transação do INSERT. Retorna null se não há saldo.
     */
    hold?: { userId: number; amount: number } | null;
    /** Marcos (RN-069) criados na mesma transação, ainda 'pending' até o aceite. */
    milestones?: MilestoneSpec[] | null;
  }): Promise<number | null> {
    const { hold, milestones, ...row } = data;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO contracts
           (ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee, freelancer_net, payment_mode, deadline_at)
         VALUES
           (:ulid, :clientId, :freelancerId, :serviceId, :title, :description, :price, :platformFee, :freelancerNet, :paymentMode, :deadlineAt)`,
        row,
      );
      const id = res.insertId;
      // status inicial no histórico (RN-022): NULL -> pending
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
         VALUES (:id, :changedBy, NULL, 'pending', 'Proposta enviada')`,
        { id, changedBy: data.clientId },
      );
      if (hold) {
        const ok = await applyWalletEffect(conn, {
          userId: hold.userId,
          balanceDelta: -hold.amount,
          pendingDelta: hold.amount,
          reason: 'hold',
          contractId: id,
        });
        if (!ok) {
          await conn.rollback();
          return null; // saldo insuficiente: nada é criado
        }
      }
      if (milestones && milestones.length > 0) {
        await milestonesRepository.insertMany(conn, id, milestones);
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

  async findById(id: number): Promise<ContractRow | undefined> {
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT c.*, ${HAS_REVIEW} AS has_review, ${HAS_MILESTONES} AS has_milestones FROM contracts c WHERE c.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<ContractRow[]> {
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT c.*, ${HAS_REVIEW} AS has_review, ${HAS_MILESTONES} AS has_milestones FROM contracts c
        WHERE c.client_id = :userId OR c.freelancer_id = :userId
        ORDER BY c.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  /**
   * Entregas sem resposta do cliente há mais de `days` dias (aprovação tácita).
   * A data da entrega é a última entrada 'delivered' no histórico do contrato.
   */
  async findDeliveredOlderThan(days: number): Promise<ContractRow[]> {
    const [rows] = await pool.query<ContractRow[]>(
      `SELECT c.*, ${HAS_REVIEW} AS has_review, ${HAS_MILESTONES} AS has_milestones
         FROM contracts c
        WHERE c.status = 'delivered'
          AND (SELECT MAX(h.created_at) FROM contract_status_history h
                WHERE h.contract_id = c.id AND h.new_status = 'delivered')
              < DATE_SUB(NOW(), INTERVAL :days DAY)
        ORDER BY c.id ASC
        LIMIT 200`,
      { days },
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
    /**
     * Movimentos de carteira em R$ (cliente e/ou freelancer) aplicados na MESMA transação do
     * status, com guarda de saldo e linha no extrato (wallet_transactions).
     */
    walletEffects?: WalletEffect[];
    /** Marcos do contrato mudam de status junto (ex.: pending → funded no aceite). */
    milestonesTo?: { from: string[]; to: string };
    /** Movimentos de CRÉDITOS (escrow time-bank) na mesma transação; `reason` gera ledger. */
    creditsEffects?: {
      userId: number;
      pendingDelta: number;
      balanceDelta: number;
      reason?: string;
    }[];
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
        {
          id: params.id,
          changedBy: params.changedBy,
          from: params.from,
          to: params.to,
          note: params.note,
        },
      );

      if (params.milestonesTo) {
        await conn.query<ResultSetHeader>(
          `UPDATE contract_milestones SET status = :to
            WHERE contract_id = :id AND status IN (:from)`,
          { to: params.milestonesTo.to, id: params.id, from: params.milestonesTo.from },
        );
      }

      // Guarda contra saldo negativo: se alguma carteira não existe ou ficaria negativa, aborta tudo.
      for (const eff of params.walletEffects ?? []) {
        const ok = await applyWalletEffect(conn, { ...eff, contractId: params.id });
        if (!ok) {
          await conn.rollback();
          return false;
        }
      }

      // Escrow em CRÉDITOS (time-bank): pode mover a carteira de mais de um usuário
      // (débito do cliente + crédito pendente do freelancer) na mesma transação.
      for (const eff of params.creditsEffects ?? []) {
        const [c] = await conn.query<ResultSetHeader>(
          `UPDATE wallets
              SET credits_pending = credits_pending + :pending,
                  credits_balance = credits_balance + :balance
            WHERE user_id = :userId
              AND credits_pending + :pending >= 0
              AND credits_balance + :balance >= 0`,
          { pending: eff.pendingDelta, balance: eff.balanceDelta, userId: eff.userId },
        );
        if (c.affectedRows === 0) {
          await conn.rollback();
          return false;
        }
        if (eff.reason) {
          const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT credits_balance + credits_pending AS total FROM wallets WHERE user_id = :userId`,
            { userId: eff.userId },
          );
          await conn.query<ResultSetHeader>(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, reason, contract_id)
             VALUES (:userId, :amount, :after, :reason, :contractId)`,
            {
              userId: eff.userId,
              amount: eff.pendingDelta + eff.balanceDelta,
              after: Number(rows[0]!.total),
              reason: eff.reason,
              contractId: params.id,
            },
          );
        }
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
        {
          id: params.id,
          message: params.message,
          files: params.files ? JSON.stringify(params.files) : null,
        },
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
