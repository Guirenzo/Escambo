import type { Paginated, Wallet, WalletReason, WalletTransaction } from '@escambo/types';
import { creditsService } from '../credits/credits.service';
import { walletRepository, type WalletTxRow } from './wallet.repository';

function toWalletTransaction(r: WalletTxRow): WalletTransaction {
  return {
    id: r.id,
    amount: Number(r.amount),
    pendingDelta: Number(r.pending_delta),
    balanceAfter: Number(r.balance_after),
    pendingAfter: Number(r.pending_after),
    reason: r.reason as WalletReason,
    contractId: r.contract_id,
    paymentId: r.payment_id,
    withdrawalId: r.withdrawal_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const walletService = {
  /** Cria a carteira se ainda não existir (idempotente). */
  async ensure(userId: number): Promise<void> {
    await walletRepository.getOrCreate(userId);
  },

  async getBalance(userId: number): Promise<Wallet> {
    // Bônus de boas-vindas em créditos, concedido uma única vez (bootstrap do time-bank).
    await creditsService.ensureWelcome(userId);
    const w = await walletRepository.getOrCreate(userId);
    return {
      balance: Number(w.balance),
      balancePending: Number(w.balance_pending),
      currency: w.currency,
      credits: Number(w.credits_balance),
      creditsPending: Number(w.credits_pending),
    };
  },

  /** Extrato de R$ (ledger): depósitos, reservas, escrow, reembolsos e saques. */
  async listTransactions(
    userId: number,
    page: number,
    limit: number,
  ): Promise<Paginated<WalletTransaction>> {
    const rows = await walletRepository.listTransactions(userId, limit, (page - 1) * limit);
    return { items: rows.map(toWalletTransaction), page, limit };
  },
};
