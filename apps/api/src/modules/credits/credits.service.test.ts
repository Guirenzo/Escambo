import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./credits.repository', () => ({
  creditsRepository: {
    grantWelcomeIfNew: vi.fn(),
    hasWelcome: vi.fn().mockResolvedValue(false),
    listTransactions: vi.fn(),
  },
}));
vi.mock('../auth/user-zone', () => ({ userZone: vi.fn() }));

import { creditsService } from './credits.service';
import { creditsRepository, type CreditTxRow } from './credits.repository';
import { env } from '../../config/env';
import { userZone } from '../auth/user-zone';

const repo = vi.mocked(creditsRepository);
const zone = vi.mocked(userZone);

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
    repo.hasWelcome.mockResolvedValueOnce(false);
    repo.grantWelcomeIfNew.mockResolvedValue(undefined);
    await creditsService.ensureWelcome(7);
    expect(repo.hasWelcome).toHaveBeenCalledWith(7);
    expect(repo.grantWelcomeIfNew).toHaveBeenCalledWith(7, env.CREDITS_WELCOME_BONUS);
  });

  it('ensureWelcome de quem já recebeu não abre a transação nem trava a carteira', async () => {
    repo.hasWelcome.mockResolvedValueOnce(true);
    await creditsService.ensureWelcome(7);
    expect(repo.grantWelcomeIfNew).not.toHaveBeenCalled();
  });

  it('ensureWelcome sem bônus configurado não consulta nada', async () => {
    const configured = env.CREDITS_WELCOME_BONUS;
    env.CREDITS_WELCOME_BONUS = 0;
    try {
      await creditsService.ensureWelcome(7);
      expect(repo.hasWelcome).not.toHaveBeenCalled();
      expect(repo.grantWelcomeIfNew).not.toHaveBeenCalled();
    } finally {
      env.CREDITS_WELCOME_BONUS = configured;
    }
  });

  it('listTransactions mapeia o ledger e pagina', async () => {
    repo.listTransactions.mockResolvedValue([
      fakeTx(),
      fakeTx({ id: 2, amount: '-40', reason: 'escrow_hold', contract_id: 9 }),
    ]);
    const r = await creditsService.listTransactions(7, 2, 20);
    expect(r.page).toBe(2);
    expect(r.items[0]).toMatchObject({
      id: 1,
      amount: 100,
      balanceAfter: 100,
      reason: 'welcome',
      contractId: null,
    });
    expect(r.items[1]).toMatchObject({ id: 2, amount: -40, reason: 'escrow_hold', contractId: 9 });
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 21, 20, {}); // offset = (page-1)*limit
  });

  it('o extrato pede ao repositório o limite e o deslocamento (página - 1) × limite, nessa ordem, e devolve cada lançamento inteiro', async () => {
    repo.listTransactions.mockResolvedValue([
      fakeTx({
        id: 31,
        amount: '-40.00',
        balance_after: '60.00',
        reason: 'escrow_hold',
        contract_id: 9,
        created_at: new Date('2026-09-01T12:30:00Z'),
      }),
    ]);

    // Página 3 de 10 em 10: limite 10, pula 20 (com limite e deslocamento diferentes, a troca
    // de um pelo outro aparece).
    expect(await creditsService.listTransactions(7, 3, 10)).toEqual({
      page: 3,
      limit: 10,
      hasMore: false,
      items: [
        {
          id: 31,
          amount: -40,
          balanceAfter: 60,
          reason: 'escrow_hold',
          contractId: 9,
          createdAt: '2026-09-01T12:30:00.000Z',
        },
      ],
    });
    expect(repo.listTransactions).toHaveBeenCalledTimes(1);
    // Um a mais que o limite: a sobra só diz se há outra página.
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 11, 20, {});
  });

  it('a primeira página não pula nada, e usuário sem lançamentos recebe a lista vazia', async () => {
    repo.listTransactions.mockResolvedValue([]);

    expect(await creditsService.listTransactions(7, 1, 50)).toEqual({
      items: [],
      page: 1,
      limit: 50,
      hasMore: false,
    });
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 51, 0, {});
    // Sem período, nem busca o fuso da conta.
    expect(zone).not.toHaveBeenCalled();
  });

  it('"Carregar mais" (RF-047): a linha que sobra do limite não aparece e diz que há outra página', async () => {
    repo.listTransactions.mockResolvedValue([
      fakeTx({ id: 3 }),
      fakeTx({ id: 2 }),
      fakeTx({ id: 1 }),
    ]);

    const page = await creditsService.listTransactions(7, 1, 2);

    expect(page.items.map((t) => t.id)).toEqual([3, 2]);
    expect(page.hasMore).toBe(true);
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 3, 0, {});
  });

  it('o período é de dias no fuso da conta de quem lê, como no extrato de R$', async () => {
    repo.listTransactions.mockResolvedValue([]);
    zone.mockResolvedValue('America/Manaus');

    await creditsService.listTransactions(7, 2, 20, { from: '2026-10-01', to: '2026-10-01' });

    expect(zone).toHaveBeenCalledWith(7);
    // Em Manaus (UTC−4), o dia 01/10 vai das 04:00 UTC de 01/10 às 04:00 UTC de 02/10.
    expect(repo.listTransactions).toHaveBeenCalledWith(7, 21, 20, {
      from: new Date('2026-10-01T04:00:00.000Z'),
      to: new Date('2026-10-02T04:00:00.000Z'),
    });
  });

  it('período invertido é recusado (400 invalid_range) sem consultar o extrato', async () => {
    await expect(
      creditsService.listTransactions(7, 1, 20, { from: '2026-10-15', to: '2026-10-01' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    expect(repo.listTransactions).not.toHaveBeenCalled();
  });

  it('ensureWelcome repassa o bônus configurado no ambiente e a falha do repositório sobe', async () => {
    const configured = env.CREDITS_WELCOME_BONUS;
    env.CREDITS_WELCOME_BONUS = 250;
    try {
      repo.hasWelcome.mockResolvedValue(false);
      repo.grantWelcomeIfNew.mockResolvedValueOnce(undefined);
      expect(await creditsService.ensureWelcome(12)).toBeUndefined();
      expect(repo.grantWelcomeIfNew).toHaveBeenCalledTimes(1);
      expect(repo.grantWelcomeIfNew).toHaveBeenCalledWith(12, 250);

      const boom = new Error('deadlock');
      repo.grantWelcomeIfNew.mockRejectedValueOnce(boom);
      await expect(creditsService.ensureWelcome(12)).rejects.toBe(boom);
    } finally {
      env.CREDITS_WELCOME_BONUS = configured;
    }
  });
});
