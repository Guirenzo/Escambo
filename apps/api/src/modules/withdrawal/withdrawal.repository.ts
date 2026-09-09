import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { applyWalletEffect, recordWalletTx } from '../wallet/wallet.ledger';

export interface WithdrawalRow extends RowDataPacket {
  id: number;
  user_id: number;
  amount: string;
  status: string;
  pix_key: string | null;
  bank_name: string | null;
  bank_agency: string | null;
  bank_account: string | null;
  gateway_ref: string | null;
  created_at: Date;
  processed_at: Date | null;
}

/** Saque com os dados do titular (fila do admin). */
export interface AdminWithdrawalRow extends WithdrawalRow {
  user_ulid: string;
  user_email: string;
  user_name: string | null;
}

const COLS = `w.id, w.user_id, w.amount, w.status, w.pix_key, w.bank_name, w.bank_agency,
              w.bank_account, w.gateway_ref, w.created_at, w.processed_at`;

/** Saque + titular (e-mail e nome do perfil de freelancer ou de cliente). */
const ADMIN_SELECT = `SELECT ${COLS}, u.ulid AS user_ulid, u.email AS user_email,
              COALESCE(fp.full_name, cp.full_name) AS user_name
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         LEFT JOIN profiles_freelancer fp ON fp.user_id = w.user_id
         LEFT JOIN profiles_client cp ON cp.user_id = w.user_id`;

export const withdrawalRepository = {
  /**
   * Cria o saque debitando o saldo disponível na MESMA transação (RNF-038), com linha no
   * extrato. A guarda `balance >= amount` impede saldo negativo; retorna null se insuficiente.
   */
  async createIfSufficient(params: {
    userId: number;
    amount: number;
    pixKey: string | null;
    bankName: string | null;
    bankAgency: string | null;
    bankAccount: string | null;
  }): Promise<number | null> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query<ResultSetHeader>(`INSERT IGNORE INTO wallets (user_id) VALUES (:userId)`, {
        userId: params.userId,
      });
      const [wallets] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM wallets WHERE user_id = :userId LIMIT 1`,
        { userId: params.userId },
      );
      const walletId = Number(wallets[0]?.id);

      const debited = await applyWalletEffect(conn, {
        userId: params.userId,
        balanceDelta: -params.amount,
        pendingDelta: 0,
      });
      if (!debited) {
        await conn.rollback();
        return null; // saldo insuficiente
      }

      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO withdrawals
           (user_id, wallet_id, amount, bank_name, bank_agency, bank_account, pix_key)
         VALUES
           (:userId, :walletId, :amount, :bankName, :bankAgency, :bankAccount, :pixKey)`,
        {
          userId: params.userId,
          walletId,
          amount: params.amount,
          bankName: params.bankName,
          bankAgency: params.bankAgency,
          bankAccount: params.bankAccount,
          pixKey: params.pixKey,
        },
      );
      await recordWalletTx(conn, {
        userId: params.userId,
        balanceDelta: -params.amount,
        pendingDelta: 0,
        reason: 'withdrawal',
        withdrawalId: res.insertId,
      });

      await conn.commit();
      return res.insertId;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async findById(id: number): Promise<WithdrawalRow | undefined> {
    const [rows] = await pool.query<WithdrawalRow[]>(
      `SELECT ${COLS} FROM withdrawals w WHERE w.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<WithdrawalRow[]> {
    const [rows] = await pool.query<WithdrawalRow[]>(
      `SELECT ${COLS} FROM withdrawals w WHERE w.user_id = :userId
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows;
  },

  /** Fila do admin: saques nos status pedidos, mais antigos primeiro, com o titular. */
  async listForAdmin(statuses: string[], limit: number): Promise<AdminWithdrawalRow[]> {
    if (statuses.length === 0) return [];
    const [rows] = await pool.query<AdminWithdrawalRow[]>(
      `${ADMIN_SELECT}
        WHERE w.status IN (:statuses)
        ORDER BY w.created_at ASC, w.id ASC
        LIMIT ${limit}`,
      { statuses },
    );
    return rows;
  },

  async findForAdmin(id: number): Promise<AdminWithdrawalRow | undefined> {
    const [rows] = await pool.query<AdminWithdrawalRow[]>(
      `${ADMIN_SELECT} WHERE w.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /** Avança o status (requested → processing → completed) com concorrência otimista. */
  async advance(
    id: number,
    from: string[],
    to: 'processing' | 'completed',
    gatewayRef: string | null,
  ): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE withdrawals
          SET status = :to,
              gateway_ref = COALESCE(:gatewayRef, gateway_ref),
              processed_at = CASE WHEN :to = 'completed' THEN NOW() ELSE processed_at END
        WHERE id = :id AND status IN (:from)`,
      { to, gatewayRef, id, from },
    );
    return res.affectedRows > 0;
  },

  /**
   * Encerra o saque sem pagar (failed / cancelled) e DEVOLVE o valor ao saldo disponível na
   * mesma transação, com linha no extrato. Retorna false se o status já não permitia.
   */
  async closeAndRefund(id: number, from: string[], to: 'failed' | 'cancelled'): Promise<boolean> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<WithdrawalRow[]>(
        `SELECT ${COLS} FROM withdrawals w WHERE w.id = :id FOR UPDATE`,
        { id },
      );
      const row = rows[0];
      if (!row || !from.includes(row.status)) {
        await conn.rollback();
        return false;
      }
      await conn.query<ResultSetHeader>(
        `UPDATE withdrawals SET status = :to, processed_at = NOW() WHERE id = :id`,
        { to, id },
      );
      const ok = await applyWalletEffect(conn, {
        userId: row.user_id,
        balanceDelta: Number(row.amount),
        pendingDelta: 0,
        reason: 'withdrawal_refund',
        withdrawalId: id,
      });
      if (!ok) {
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
