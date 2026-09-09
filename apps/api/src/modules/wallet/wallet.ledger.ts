import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { WalletReason } from '@escambo/types';

/**
 * Ledger de R$ (wallet_transactions): toda movimentação de saldo disponível e/ou retido é
 * gravada na MESMA transação do efeito, com os saldos resultantes — o extrato é auditável e
 * reconstruível, como o ledger de créditos (ADR 3).
 */

export interface WalletEffect {
  userId: number;
  /** Variação do saldo disponível. */
  balanceDelta: number;
  /** Variação do saldo retido (escrow / reserva da proposta). */
  pendingDelta: number;
  /** Motivo do extrato; sem ele o movimento não gera linha (uso interno raro). */
  reason?: WalletReason;
  contractId?: number | null;
  paymentId?: number | null;
  withdrawalId?: number | null;
}

/**
 * Aplica um efeito na carteira com guarda contra saldo negativo (disponível E retido) e
 * grava a linha do extrato. Retorna false se a carteira não existe ou ficaria negativa —
 * quem chama decide o rollback.
 */
export async function applyWalletEffect(conn: PoolConnection, eff: WalletEffect): Promise<boolean> {
  const [upd] = await conn.query<ResultSetHeader>(
    `UPDATE wallets
        SET balance_pending = balance_pending + :pending,
            balance         = balance + :balance
      WHERE user_id = :userId
        AND balance_pending + :pending >= 0
        AND balance + :balance >= 0`,
    { pending: eff.pendingDelta, balance: eff.balanceDelta, userId: eff.userId },
  );
  if (upd.affectedRows === 0) return false;
  if (eff.reason) await recordWalletTx(conn, eff as WalletEffect & { reason: WalletReason });
  return true;
}

/** Grava a linha do extrato lendo os saldos resultantes da própria transação. */
export async function recordWalletTx(
  conn: PoolConnection,
  eff: WalletEffect & { reason: WalletReason },
): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT balance, balance_pending FROM wallets WHERE user_id = :userId LIMIT 1`,
    { userId: eff.userId },
  );
  const w = rows[0];
  if (!w) return;
  await conn.query<ResultSetHeader>(
    `INSERT INTO wallet_transactions
       (user_id, amount, pending_delta, balance_after, pending_after, reason, contract_id, payment_id, withdrawal_id)
     VALUES
       (:userId, :amount, :pendingDelta, :balanceAfter, :pendingAfter, :reason, :contractId, :paymentId, :withdrawalId)`,
    {
      userId: eff.userId,
      amount: eff.balanceDelta,
      pendingDelta: eff.pendingDelta,
      balanceAfter: Number(w.balance),
      pendingAfter: Number(w.balance_pending),
      reason: eff.reason,
      contractId: eff.contractId ?? null,
      paymentId: eff.paymentId ?? null,
      withdrawalId: eff.withdrawalId ?? null,
    },
  );
}
