/**
 * Ledger da carteira em reais (camada de repository, compartilhada pelos módulos de dinheiro).
 * É o ponto único por onde o saldo muda: aplica a variação na tabela `wallets` com a guarda contra
 * saldo negativo e grava a linha do extrato em `wallet_transactions`, na mesma transação.
 * A carteira tem dois saldos: `balance` (disponível, dá para sacar ou gastar) e `balance_pending`
 * (retido: a reserva da proposta e o escrow da contratação em andamento).
 * Quem chama: os repositories de contratos, ofertas, marcos, disputas, trocas, pagamentos e saques,
 * sempre com a conexão de uma transação já aberta (quem chama faz o commit ou o rollback).
 * Dentro: WalletEffect (o que mudar), applyWalletEffect (guarda e efeito) e recordWalletTx
 * (linha do extrato).
 * O extrato é imutável no banco (migration 0046): erro se corrige com um lançamento de estorno.
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { WalletReason } from '@escambo/types';

/**
 * Ledger de R$ (wallet_transactions): toda movimentação de saldo disponível e/ou retido é
 * gravada na MESMA transação do efeito, com os saldos resultantes — o extrato é auditável e
 * reconstruível, como o ledger de créditos (ADR 3).
 */

// Um movimento: de quem é a carteira, quanto entra (positivo) ou sai (negativo) de cada saldo, o
// motivo do extrato e a ligação com a contratação, o pagamento ou o saque que o causou.
// Exemplo, a reserva da proposta: balanceDelta -100 e pendingDelta +100 (sai do disponível e
// fica retido).
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
  // A guarda de saldo está no próprio comando: ele soma as variações nos dois saldos só se os
  // dois continuarem maiores ou iguais a zero. Conferir e gravar é uma operação só no banco, sem
  // "ler o saldo e depois gravar", então duas requisições ao mesmo tempo não gastam o mesmo real.
  const [upd] = await conn.query<ResultSetHeader>(
    `UPDATE wallets
        SET balance_pending = balance_pending + :pending,
            balance         = balance + :balance
      WHERE user_id = :userId
        AND balance_pending + :pending >= 0
        AND balance + :balance >= 0`,
    { pending: eff.pendingDelta, balance: eff.balanceDelta, userId: eff.userId },
  );
  // Zero linhas afetadas: não tem carteira ou o saldo ficaria negativo. Nada mudou; quem chama
  // desfaz a transação e responde, por exemplo, 402 insufficient_balance.
  if (upd.affectedRows === 0) return false;
  // Com motivo, grava a linha do extrato na mesma conexão (mesma transação do efeito).
  if (eff.reason) await recordWalletTx(conn, eff as WalletEffect & { reason: WalletReason });
  return true;
}

/** Grava a linha do extrato lendo os saldos resultantes da própria transação. */
export async function recordWalletTx(
  conn: PoolConnection,
  eff: WalletEffect & { reason: WalletReason },
): Promise<void> {
  // Lê os saldos depois da mudança, dentro da mesma transação: a linha do extrato guarda como a
  // carteira ficou, e o extrato pode ser conferido linha a linha.
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT balance, balance_pending FROM wallets WHERE user_id = :userId LIMIT 1`,
    { userId: eff.userId },
  );
  const w = rows[0];
  if (!w) return;
  // Grava a linha do extrato: o valor do disponível (amount), a variação do retido, os saldos
  // resultantes, o motivo e as ligações (contratação, pagamento, saque), nulas quando não há.
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
