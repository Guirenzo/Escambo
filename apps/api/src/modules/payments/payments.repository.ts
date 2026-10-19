import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { inTransaction, pool } from '../../config/db';
import { applyWalletEffect } from '../wallet/wallet.ledger';
import { walletRepository } from '../wallet/wallet.repository';
import { lockWallets } from '../wallet/wallet.locks';
import { insertPaymentEvent, type PaymentEventInput } from './payment-events';

/** O que chegou do gateway (ou da simulação) e liquidou a cobrança: vira linha do histórico. */
export type SettleNotice = Pick<PaymentEventInput, 'source' | 'event' | 'payload'>;

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
  /**
   * Registra a cobrança de depósito (top-up) criada no gateway, com a resposta completa da criação
   * em `gateway_response` e a primeira linha do histórico (RF-050), na mesma transação: não existe
   * cobrança sem o registro do que o gateway respondeu.
   */
  async createTopup(p: {
    payerId: number;
    amount: number;
    gateway: string;
    gatewayPaymentId: string;
    /** Resposta da criação, já higienizada; precisa trazer o `pixCode` no topo. */
    response: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<number> {
    return inTransaction(async (conn) => {
      const [res] = await conn.query<ResultSetHeader>(
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
          response: JSON.stringify(p.response),
          expiresAt: p.expiresAt,
        },
      );
      await insertPaymentEvent(conn, {
        paymentId: res.insertId,
        gateway: p.gateway,
        gatewayPaymentId: p.gatewayPaymentId,
        source: 'charge',
        event: null,
        status: 'pending',
        outcome: 'created',
        payload: p.response,
      });
      return res.insertId;
    });
  },

  /**
   * Linha avulsa do histórico do gateway (autocommit): webhook repetido ou atrasado (`ignored`),
   * de cobrança desconhecida (`not_found`) ou com corpo fora do formato (`invalid`). O que liquida
   * a cobrança é gravado dentro da própria liquidação (`settle`).
   */
  async recordEvent(e: PaymentEventInput): Promise<void> {
    await insertPaymentEvent(pool, e);
  },

  async findById(id: number): Promise<PaymentRow | undefined> {
    const [rows] = await pool.query<PaymentRow[]>(
      `SELECT ${COLS} FROM payments WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /** Só depósito: o webhook do gateway liquida top-up, nunca outro tipo de pagamento. */
  async findByGatewayId(gatewayPaymentId: string): Promise<PaymentRow | undefined> {
    const [rows] = await pool.query<PaymentRow[]>(
      `SELECT ${COLS} FROM payments
        WHERE kind = 'topup' AND gateway_payment_id = :gatewayPaymentId LIMIT 1`,
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
   * credita a carteira do pagador e grava o extrato na mesma transação (RNF-038). Com `notice`, o
   * que chegou do gateway entra no histórico (RF-050) também na mesma transação, como `applied`.
   * Retorna false se a cobrança já não estava pendente (ou não é um depósito); aí nada é gravado
   * aqui, e quem chama registra a repetição.
   */
  async settle(id: number, status: 'paid' | 'failed', notice?: SettleNotice): Promise<boolean> {
    if (status === 'paid') {
      // O pagador é imutável. O status será conferido de novo sob a trava da cobrança.
      const [payers] = await pool.query<RowDataPacket[]>(
        `SELECT payer_id FROM payments WHERE id = :id AND kind = 'topup' AND status = 'pending'`,
        { id },
      );
      if (!payers[0]) return false;
      await walletRepository.ensure(Number(payers[0].payer_id));
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<PaymentRow[]>(
        `SELECT ${COLS} FROM payments WHERE id = :id AND kind = 'topup' FOR UPDATE`,
        { id },
      );
      const row = rows[0];
      if (!row || row.status !== 'pending') {
        await conn.rollback();
        return false;
      }
      if (status === 'paid') await lockWallets(conn, [row.payer_id]);
      await conn.query<ResultSetHeader>(
        `UPDATE payments SET status = :status, paid_at = :paidAt WHERE id = :id`,
        { status, paidAt: status === 'paid' ? new Date() : null, id },
      );
      if (status === 'paid') {
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
      if (notice) {
        await insertPaymentEvent(conn, {
          ...notice,
          paymentId: id,
          gateway: row.gateway,
          gatewayPaymentId: row.gateway_payment_id,
          status,
          outcome: 'applied',
        });
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
