import type { Wallet } from '@escambo/types';
import { walletRepository } from './wallet.repository';

export const walletService = {
  /** Cria a carteira se ainda não existir (idempotente). */
  async ensure(userId: number): Promise<void> {
    await walletRepository.getOrCreate(userId);
  },

  async getBalance(userId: number): Promise<Wallet> {
    const w = await walletRepository.getOrCreate(userId);
    return {
      balance: Number(w.balance),
      balancePending: Number(w.balance_pending),
      currency: w.currency,
    };
  },
};
