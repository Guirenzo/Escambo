import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wallet.repository', () => ({
  walletRepository: { getOrCreate: vi.fn(), listTransactions: vi.fn() },
}));
vi.mock('../credits/credits.service', () => ({
  creditsService: { ensureWelcome: vi.fn() },
}));

import { walletService } from './wallet.service';
import { walletRepository, type WalletRow, type WalletTxRow } from './wallet.repository';
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

  it('concede o bônus de boas-vindas antes de ler a carteira, para o saldo devolvido já contar com ele', async () => {
    credits.ensureWelcome.mockResolvedValue(undefined);
    // A moeda é a gravada na carteira (outra de propósito, para não passar com um valor fixo).
    repo.getOrCreate.mockResolvedValue({
      balance: '0.00',
      balance_pending: '0.00',
      currency: 'USD',
      credits_balance: '100',
      credits_pending: '0',
    } as unknown as WalletRow);

    expect(await walletService.getBalance(7)).toEqual({
      balance: 0,
      balancePending: 0,
      currency: 'USD',
      credits: 100,
      creditsPending: 0,
    });

    expect(repo.getOrCreate).toHaveBeenCalledTimes(1);
    expect(repo.getOrCreate).toHaveBeenCalledWith(7);
    expect(credits.ensureWelcome.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.getOrCreate.mock.invocationCallOrder[0]!,
    );
  });

  it('se o bônus falha, o erro sobe e a carteira não é lida', async () => {
    const boom = new Error('deadlock');
    credits.ensureWelcome.mockRejectedValue(boom);

    await expect(walletService.getBalance(7)).rejects.toBe(boom);

    expect(repo.getOrCreate).not.toHaveBeenCalled();
  });
});

describe('walletService.ensure', () => {
  it('garante a carteira do usuário pedido sem conceder bônus nem devolver saldo', async () => {
    repo.getOrCreate.mockResolvedValue({ id: 2, user_id: 7 } as unknown as WalletRow);

    expect(await walletService.ensure(7)).toBeUndefined();

    expect(repo.getOrCreate).toHaveBeenCalledTimes(1);
    expect(repo.getOrCreate).toHaveBeenCalledWith(7);
    expect(credits.ensureWelcome).not.toHaveBeenCalled();
  });
});

describe('walletService.listTransactions', () => {
  it('pagina pelo deslocamento (página - 1) × limite e mapeia cada linha do extrato para números e data ISO', async () => {
    repo.listTransactions.mockResolvedValue([
      {
        id: 31,
        amount: '-150.00',
        pending_delta: '150.00',
        balance_after: '350.00',
        // Já havia R$ 20 retidos: o retido depois (170) não é a variação (150).
        pending_after: '170.00',
        reason: 'hold',
        contract_id: 9,
        payment_id: null,
        withdrawal_id: null,
        created_at: new Date('2026-09-01T12:30:00Z'),
      },
      {
        id: 30,
        amount: '500.00',
        pending_delta: '0.00',
        balance_after: '500.00',
        pending_after: '0.00',
        reason: 'deposit',
        contract_id: null,
        payment_id: 12,
        withdrawal_id: null,
        created_at: new Date('2026-09-01T12:00:00Z'),
      },
      {
        id: 29,
        amount: '-80.00',
        pending_delta: '0.00',
        balance_after: '420.00',
        pending_after: '20.00',
        reason: 'withdrawal',
        contract_id: null,
        payment_id: null,
        withdrawal_id: 5,
        created_at: new Date('2026-09-01T11:00:00Z'),
      },
    ] as unknown as WalletTxRow[]);

    const page = await walletService.listTransactions(7, 3, 20);

    expect(repo.listTransactions).toHaveBeenCalledWith(7, 20, 40);
    expect(page).toEqual({
      page: 3,
      limit: 20,
      items: [
        {
          id: 31,
          amount: -150,
          pendingDelta: 150,
          balanceAfter: 350,
          pendingAfter: 170,
          reason: 'hold',
          contractId: 9,
          paymentId: null,
          withdrawalId: null,
          createdAt: '2026-09-01T12:30:00.000Z',
        },
        {
          id: 30,
          amount: 500,
          pendingDelta: 0,
          balanceAfter: 500,
          pendingAfter: 0,
          reason: 'deposit',
          contractId: null,
          paymentId: 12,
          withdrawalId: null,
          createdAt: '2026-09-01T12:00:00.000Z',
        },
        // Cada lançamento aponta para o que o originou: aqui, o saque.
        {
          id: 29,
          amount: -80,
          pendingDelta: 0,
          balanceAfter: 420,
          pendingAfter: 20,
          reason: 'withdrawal',
          contractId: null,
          paymentId: null,
          withdrawalId: 5,
          createdAt: '2026-09-01T11:00:00.000Z',
        },
      ],
    });
  });

  it('a primeira página começa do zero, e extrato vazio devolve a lista vazia', async () => {
    repo.listTransactions.mockResolvedValue([]);

    expect(await walletService.listTransactions(7, 1, 50)).toEqual({
      items: [],
      page: 1,
      limit: 50,
    });
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 50, 0);
  });
});
