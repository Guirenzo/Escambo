import type { CreditReason, CreditTransaction, Paginated } from '@escambo/types';
import { env } from '../../config/env';
import { creditsRepository, type CreditTxRow } from './credits.repository';

function toTransaction(row: CreditTxRow): CreditTransaction {
  return {
    id: row.id,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    reason: row.reason as CreditReason,
    contractId: row.contract_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export const creditsService = {
  /** Concede o bônus de boas-vindas (uma vez) no primeiro acesso à carteira. */
  async ensureWelcome(userId: number): Promise<void> {
    await creditsRepository.grantWelcomeIfNew(userId, env.CREDITS_WELCOME_BONUS);
  },

  async listTransactions(userId: number, page: number, limit: number): Promise<Paginated<CreditTransaction>> {
    const rows = await creditsRepository.listTransactions(userId, limit, (page - 1) * limit);
    return { items: rows.map(toTransaction), page, limit };
  },
};
