import type { CreditReason, CreditTransaction, CreditTransactionsPage } from '@escambo/types';
import { env } from '../../config/env';
import { userZone } from '../auth/user-zone';
import { ledgerPage, periodRange, type WalletPeriod } from '../wallet/wallet.period';
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
    if (env.CREDITS_WELCOME_BONUS <= 0) return;
    // Quem já recebeu (quase todo GET /wallet) não abre transação nem trava a carteira: o teste
    // de carga mostrou essa trava como a leitura mais lenta sob concorrência (docs/desempenho.md).
    if (await creditsRepository.hasWelcome(userId)) return;
    await creditsRepository.grantWelcomeIfNew(userId, env.CREDITS_WELCOME_BONUS);
  },

  /**
   * Extrato de créditos, com o mesmo período do extrato de R$ (RF-047): dias no fuso da conta de
   * quem lê. Pede um lançamento a mais para saber se há outra página.
   */
  async listTransactions(
    userId: number,
    page: number,
    limit: number,
    period: WalletPeriod = {},
  ): Promise<CreditTransactionsPage> {
    const range = await periodRange(period, () => userZone(userId));
    const rows = await creditsRepository.listTransactions(
      userId,
      limit + 1,
      (page - 1) * limit,
      range,
    );
    return ledgerPage(rows, page, limit, toTransaction);
  },
};
