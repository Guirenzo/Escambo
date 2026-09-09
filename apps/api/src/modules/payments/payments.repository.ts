import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { applyWalletEffect } from '../wallet/wallet.ledger';

export interface PaymentRow extends RowDataPacket {
  id: number;
  kind: string;
  payer_id: number;
  amount: string;
  method: string;
  status: string;
  gateway: string;
  gateway_payment_id: string | null;
  gateway_response: string | Record<string, unknown> | null;
  paid_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

const COLS = `id, kind, payer_id, amount, method, status, gateway, gateway_payment_id,
              gateway_response, paid_at, expires_at, created_at`;

export const paymentsRepository = {
  /** Registra a cobrança de depósito (top-up) criada no gateway. */
  async createTopup(p: {
    payerId: number;
    amount: number;
    gateway: string;
    gatewayPaymentId: string;
    pixCode: string;
    expiresAt: Date;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO payments
         (kind, contract_id, payer_id, payee_id, amount, platform_fee, net_amount, method, status,
          gateway, gateway_payment_id, gateway_response, expires_at)
       VALUES
         ('topup', NULL, :payerId, NULL, :amount, 0, :amount, 'pix', 'pending',
          :gateway, :gatewayPaymentId, :response, :expiresAt)`,
      {
        payerId: p.payerId,
        amount: p.amount,
        gateway: p.gateway,
        gatewayPaymentId: p.gatewayPaymentId,
        response: JSON.stringify({ pixCode: p.pixCode }),
        expiresAt: p.expiresAt,
      },
    );
    return res.insertId;
  },

  async findById(id: number): Promise<PaymentRow | undefined> {
    const [rows] = await pool.query<PaymentRow[]>(
      `SELECT ${COLS} FROM payments WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async findByGatewayId(gatewayPaymentId: string): Promise<PaymentRow | undefined> {
    const [rows] = await pool.query<PaymentRow[]>(
      `SELECT ${COLS} FROM payments WHERE gateway_payment_id = :gatewayPaymentId LIMIT 1`,
      { gatewayPaymentId },
    );
    return rows[0];
  },

  async listTopupsForUser(payerId: number, limit: number, offset: number): Promise<PaymentRow[]> {
    const [rows] = await pool.query<PaymentRow[]>(
      `SELECT ${COLS} FROM payments
        WHERE kind = 'topup' AND payer_id = :payerId
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { payerId },
    );
    return rows;
  },

  /**
   * Liquida a cobrança (pago/falhou) de forma IDEMPOTENTE: só sai de 'pending'. Se pago,
   * credita a carteira do pagador e grava o extrato na mesma transação (RNF-038).
   * Retorna false se a cobrança já não estava pendente.
   */
  async settle(id: number, status: 'paid' | 'failed'): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<PaymentRow[]>(
        `SELECT ${COLS} FROM payments WHERE id = :id FOR UPDATE`,
        { id },
      );
      const row = rows[0];
      if (!row || row.status !== 'pending') {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE payments SET status = :status, paid_at = :paidAt WHERE id = :id`,
        { status, paidAt: status === 'paid' ? new Date() : null, id },
      );
      if (status === 'paid') {
        await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
          userId: row.payer_id,
        });
        const ok = await applyWalletEffect(conn, {
          userId: row.payer_id,
          balanceDelta: Number(row.amount),
          pendingDelta: 0,
          reason: 'deposit',
          paymentId: id,
        });
        if (!ok) {
          await conn.rollback();
          return false;
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

  /** Cobranças de depósito vencidas viram 'cancelled' (job). */
  async expirePending(): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE payments SET status = 'cancelled'
        WHERE kind = 'topup' AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()`,
    );
    return res.affectedRows;
  },
};
