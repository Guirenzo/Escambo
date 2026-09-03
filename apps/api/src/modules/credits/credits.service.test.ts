import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./credits.repository', () => ({
  creditsRepository: { grantWelcomeIfNew: vi.fn(), listTransactions: vi.fn() },
}));

import { creditsService } from './credits.service';
import { creditsRepository, type CreditTxRow } from './credits.repository';
import { env } from '../../config/env';

const repo = vi.mocked(creditsRepository);

type TxFields = Partial<{
  id: number;
  user_id: number;
  amount: string;
  balance_after: string;
  reason: string;
  contract_id: number | null;
  created_at: Date;
}>;

const fakeTx = (o: TxFields = {}): CreditTxRow =>
  ({
    id: 1,
    user_id: 7,
    amount: '100',
    balance_after: '100',
    reason: 'welcome',
    contract_id: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as CreditTxRow;

beforeEach(() => vi.clearAllMocks());

describe('creditsService', () => {
  it('ensureWelcome concede o bônus configurado (uma vez, no repositório)', async () => {
    repo.grantWelcomeIfNew.mockResolvedValue(undefined);
    await creditsService.ensureWelcome(7);
    expect(repo.grantWelcomeIfNew).toHaveBeenCalledWith(7, env.CREDITS_WELCOME_BONUS);
  });

  it('listTransactions mapeia o ledger e pagina', async () => {
    repo.listTransactions.mockResolvedValue([fakeTx(), fakeTx({ id: 2, amount: '-40', reason: 'escrow_hold', contract_id: 9 })]);
    const r = await creditsService.listTransactions(7, 2, 20);
    expect(r.page).toBe(2);
    expect(r.items[0]).toMatchObject({ id: 1, amount: 100, balanceAfter: 100, reason: 'welcome', contractId: null });
    expect(r.items[1]).toMatchObject({ id: 2, amount: -40, reason: 'escrow_hold', contractId: 9 });
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 20, 20); // offset = (page-1)*limit
  });
});
