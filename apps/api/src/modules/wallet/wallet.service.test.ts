import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wallet.repository', () => ({
  walletRepository: { getOrCreate: vi.fn() },
}));

import { walletService } from './wallet.service';
import { walletRepository, type WalletRow } from './wallet.repository';

const repo = vi.mocked(walletRepository);

beforeEach(() => vi.clearAllMocks());

describe('walletService.getBalance', () => {
  it('mapeia DECIMAL (string) para number', async () => {
    repo.getOrCreate.mockResolvedValue({
      id: 1,
      user_id: 1,
      balance: '850.00',
      balance_pending: '150.00',
      currency: 'BRL',
    } as unknown as WalletRow);

    const w = await walletService.getBalance(1);

    expect(w.balance).toBe(850);
    expect(w.balancePending).toBe(150);
    expect(w.currency).toBe('BRL');
  });
});
