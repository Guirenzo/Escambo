import type { Wallet } from '@escambo/types';
import { creditsService } from '../credits/credits.service';
import { walletRepository } from './wallet.repository';

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
};
