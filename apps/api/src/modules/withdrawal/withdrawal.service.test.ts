import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./withdrawal.repository', () => ({
  withdrawalRepository: {
    createIfSufficient: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
  },
}));

import { withdrawalService } from './withdrawal.service';
import { withdrawalRepository, type WithdrawalRow } from './withdrawal.repository';

const repo = vi.mocked(withdrawalRepository);

function fakeRow(
  o: Partial<{
    id: number;
    amount: string;
    status: string;
    pix_key: string | null;
    bank_account: string | null;
    processed_at: Date | null;
  }> = {},
): WithdrawalRow {
  return {
    id: 1,
    amount: '50.00',
    status: 'requested',
    pix_key: 'minha-chave-pix-9876',
    bank_account: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    processed_at: null,
    ...o,
  } as unknown as WithdrawalRow;
}

beforeEach(() => vi.clearAllMocks());

describe('withdrawalService.request', () => {
  it('400 quando o saldo é insuficiente (RN-034)', async () => {
    repo.createIfSufficient.mockResolvedValue(null);
    await expect(
      withdrawalService.request(1, { amount: 50, method: 'pix', pixKey: 'x' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cria o saque e mascara a chave PIX na resposta', async () => {
    repo.createIfSufficient.mockResolvedValue(10);
    repo.findById.mockResolvedValue(fakeRow({ id: 10, pix_key: 'minha-chave-pix-9876' }));

    const w = await withdrawalService.request(1, {
      amount: 50,
      method: 'pix',
      pixKey: 'minha-chave-pix-9876',
    });

    expect(w.method).toBe('pix');
    expect(w.maskedDestination).toBe('••••9876'); // só os 4 últimos
    expect(w.amount).toBe(50);
    expect(repo.createIfSufficient).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, amount: 50, pixKey: 'minha-chave-pix-9876' }),
    );
  });
});
