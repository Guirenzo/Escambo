import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wallet.repository', () => ({
  walletRepository: { getOrCreate: vi.fn() },
}));
vi.mock('../credits/credits.service', () => ({
  creditsService: { ensureWelcome: vi.fn() },
}));

import { walletService } from './wallet.service';
import { walletRepository, type WalletRow } from './wallet.repository';
import { creditsService } from '../credits/credits.service';

const repo = vi.mocked(walletRepository);
const credits = vi.mocked(creditsService);

beforeEach(() => vi.clearAllMocks());

describe('walletService.getBalance', () => {
  it('mapeia DECIMAL (string) para number, inclui créditos e concede o bônus', async () => {
    credits.ensureWelcome.mockResolvedValue(undefined);
    repo.getOrCreate.mockResolvedValue({
      id: 1,
      user_id: 1,
      balance: '850.00',
      balance_pending: '150.00',
      currency: 'BRL',
      credits_balance: '100',
      credits_pending: '40',
    } as unknown as WalletRow);

    const w = await walletService.getBalance(1);

    expect(w).toMatchObject({
      balance: 850,
      balancePending: 150,
      currency: 'BRL',
      credits: 100,
      creditsPending: 40,
    });
    expect(credits.ensureWelcome).toHaveBeenCalledWith(1);
  });
});
