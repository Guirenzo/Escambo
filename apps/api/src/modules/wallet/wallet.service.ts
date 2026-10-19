import type {
  Wallet,
  WalletReason,
  WalletTransaction,
  WalletTransactionsPage,
} from '@escambo/types';
import { userZone } from '../auth/user-zone';
import { creditsService } from '../credits/credits.service';
import { ledgerPage, periodRange, type WalletPeriod } from './wallet.period';
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
    await walletRepository.ensure(userId);
  },

  async getBalance(userId: number, options: { readOnly?: boolean } = {}): Promise<Wallet> {
    if (options.readOnly) {
      const existing = await walletRepository.findByUserId(userId);
      return {
        balance: Number(existing?.balance ?? 0),
        balancePending: Number(existing?.balance_pending ?? 0),
        currency: existing?.currency ?? 'BRL',
        credits: Number(existing?.credits_balance ?? 0),
        creditsPending: Number(existing?.credits_pending ?? 0),
      };
    }
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

  /**
   * Extrato de R$ (ledger): depósitos, reservas, escrow, reembolsos e saques. O período (RF-047) é
   * de dias no fuso da conta de quem lê; pede um lançamento a mais para saber se há outra página.
   */
  async listTransactions(
    userId: number,
    page: number,
    limit: number,
    period: WalletPeriod = {},
  ): Promise<WalletTransactionsPage> {
    const range = await periodRange(period, () => userZone(userId));
    const rows = await walletRepository.listTransactions(
      userId,
      limit + 1,
      (page - 1) * limit,
      range,
    );
    return ledgerPage(rows, page, limit, toWalletTransaction);
  },
};
