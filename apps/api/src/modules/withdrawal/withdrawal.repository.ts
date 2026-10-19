import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { applyWalletEffect, recordWalletTx } from '../wallet/wallet.ledger';
import { walletRepository } from '../wallet/wallet.repository';
import { lockWallets } from '../wallet/wallet.locks';
import { openDestination, sealDestination, type Destination } from './withdrawal.fields';

/**
 * Saque como sai deste repository: o destino (chave PIX, dados bancários) já decifrado (RNF-017),
 * ou "[indisponível]" se o valor cifrado não decifrou. Gravado, ele está cifrado quando há chave.
 */
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
  /** Prazo de pagamento gravado no pedido (RN-035); null em saque encerrado antes da 1.44.0. */
  due_at: Date | null;
}

/** Saque com os dados do titular (fila do admin). */
export interface AdminWithdrawalRow extends WithdrawalRow {
  user_ulid: string;
  user_email: string;
  user_name: string | null;
}

const COLS = `w.id, w.user_id, w.amount, w.status, w.pix_key, w.bank_name, w.bank_agency,
              w.bank_account, w.gateway_ref, w.created_at, w.processed_at, w.due_at`;

/** O destino como está GRAVADO (cifrado ou texto puro), para o fields:encrypt. */
export interface StoredDestinationRow extends RowDataPacket {
  id: number;
  pix_key: string | null;
  bank_name: string | null;
  bank_agency: string | null;
  bank_account: string | null;
}

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
   * O prazo (RN-035) chega calculado e vai junto no INSERT: fica o que valia no pedido. O destino
   * chega em texto e é gravado cifrado (RNF-017), se houver chave.
   */
  async createIfSufficient(params: {
    userId: number;
    amount: number;
    pixKey: string | null;
    bankName: string | null;
    bankAgency: string | null;
    bankAccount: string | null;
    dueAt: Date;
  }): Promise<number | null> {
    await walletRepository.ensure(params.userId);
    const sealed = sealDestination(params);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await lockWallets(conn, [params.userId]);
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
           (user_id, wallet_id, amount, bank_name, bank_agency, bank_account, pix_key, due_at)
         VALUES
           (:userId, :walletId, :amount, :bankName, :bankAgency, :bankAccount, :pixKey, :dueAt)`,
        {
          userId: params.userId,
          walletId,
          amount: params.amount,
          bankName: sealed.bankName,
          bankAgency: sealed.bankAgency,
          bankAccount: sealed.bankAccount,
          pixKey: sealed.pixKey,
          dueAt: params.dueAt,
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
    return rows[0] && openDestination(rows[0]);
  },

  async listForUser(userId: number, limit: number, offset: number): Promise<WithdrawalRow[]> {
    const [rows] = await pool.query<WithdrawalRow[]>(
      `SELECT ${COLS} FROM withdrawals w WHERE w.user_id = :userId
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { userId },
    );
    return rows.map((row) => openDestination(row));
  },

  /**
   * Fila do admin: saques nos status pedidos, com o titular, pelo prazo (RN-035): o que vence
   * antes vem primeiro. Saque antigo sem prazo (encerrado antes da 1.44.0) entra pela data do
   * pedido; no empate, o pedido mais antigo.
   */
  async listForAdmin(statuses: string[], limit: number): Promise<AdminWithdrawalRow[]> {
    if (statuses.length === 0) return [];
    const [rows] = await pool.query<AdminWithdrawalRow[]>(
      `${ADMIN_SELECT}
        WHERE w.status IN (:statuses)
        ORDER BY COALESCE(w.due_at, w.created_at) ASC, w.created_at ASC, w.id ASC
        LIMIT ${limit}`,
      { statuses },
    );
    return rows.map((row) => openDestination(row));
  },

  async findForAdmin(id: number): Promise<AdminWithdrawalRow | undefined> {
    const [rows] = await pool.query<AdminWithdrawalRow[]>(
      `${ADMIN_SELECT} WHERE w.id = :id LIMIT 1`,
      { id },
    );
    return rows[0] && openDestination(rows[0]);
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
      // Só status, valor e titular: o destino não é usado aqui, então nem é decifrado.
      const row = rows[0];
      if (!row || !from.includes(row.status)) {
        await conn.rollback();
        return false;
      }
      await lockWallets(conn, [row.user_id]);
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

  // ---------- fields:encrypt (RNF-017) ----------

  /**
   * O próximo lote, pelo id, de saques com algum destino ainda fora da chave atual: texto puro ou
   * cifrado com uma chave antiga. Devolve o que está GRAVADO, sem decifrar. A comparação do prefixo
   * é binária: na colação da tabela, "ENC:V1:…" em texto puro passaria por cifrado.
   */
  async listStoredToSeal(
    afterId: number,
    sealedPrefix: string,
    limit: number,
  ): Promise<StoredDestinationRow[]> {
    const [rows] = await pool.query<StoredDestinationRow[]>(
      `SELECT id, pix_key, bank_name, bank_agency, bank_account
         FROM withdrawals
        WHERE id > :afterId
          AND (   (pix_key IS NOT NULL AND pix_key NOT LIKE :pattern COLLATE utf8mb4_bin)
               OR (bank_name IS NOT NULL AND bank_name NOT LIKE :pattern COLLATE utf8mb4_bin)
               OR (bank_agency IS NOT NULL AND bank_agency NOT LIKE :pattern COLLATE utf8mb4_bin)
               OR (bank_account IS NOT NULL AND bank_account NOT LIKE :pattern COLLATE utf8mb4_bin))
        ORDER BY id
        LIMIT ${limit}`,
      { afterId, pattern: `${sealedPrefix}%` },
    );
    return rows;
  },

  /**
   * Regrava o destino de um saque, só se o gravado ainda for o que foi lido (outra rodada pode ter
   * cifrado antes: aí não mexe e devolve false). updated_at fica: o saque em si não mudou.
   */
  async replaceStoredDestination(id: number, from: Destination, to: Destination): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE withdrawals
          SET pix_key = :pixKey, bank_name = :bankName, bank_agency = :bankAgency,
              bank_account = :bankAccount, updated_at = updated_at
        WHERE id = :id
          AND pix_key <=> :fromPixKey AND bank_name <=> :fromBankName
          AND bank_agency <=> :fromBankAgency AND bank_account <=> :fromBankAccount`,
      {
        id,
        ...to,
        fromPixKey: from.pixKey,
        fromBankName: from.bankName,
        fromBankAgency: from.bankAgency,
        fromBankAccount: from.bankAccount,
      },
    );
    return res.affectedRows > 0;
  },
};
