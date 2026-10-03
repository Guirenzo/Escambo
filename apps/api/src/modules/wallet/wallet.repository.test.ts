import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { walletRepository } from './wallet.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** Repository da carteira sem banco: o que cada método pede e o que devolve do resultado. */
describe('walletRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('o extrato de R$ é só do usuário pedido, do lançamento mais novo para o mais antigo, paginado', async () => {
    const rows = [{ id: 8 }, { id: 3 }];
    fakeDb.reply(rows);

    expect(await walletRepository.listTransactions(7, 20, 40)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(fakeDb.calls).toHaveLength(1);
    // As colunas que o service mapeia: valor, variação do retido, saldos depois, motivo e as origens.
    expect(sql).toMatch(
      /^SELECT id, amount, pending_delta, balance_after, pending_after, reason, contract_id, payment_id, withdrawal_id, created_at FROM /,
    );
    expect(sql).toContain(
      'FROM wallet_transactions WHERE user_id = :userId ORDER BY id DESC LIMIT 20 OFFSET 40',
    );
    expect(params).toEqual({ userId: 7 });
  });

  it('usuário sem movimentação recebe a lista vazia, e a primeira página não pula nada', async () => {
    expect(await walletRepository.listTransactions(7, 50, 0)).toEqual([]);

    expect(fakeDb.calls[0]!.sql).toMatch(/ ORDER BY id DESC LIMIT 50 OFFSET 0$/);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('getOrCreate de quem ainda não tinha carteira devolve a recém-criada, lida depois do INSERT', async () => {
    const created = { id: 9, user_id: 31, balance: '0.00', balance_pending: '0.00' };
    fakeDb.reply({ affectedRows: 1, insertId: 9 }, [created]);

    expect(await walletRepository.getOrCreate(31)).toBe(created);

    expect(fakeDb.sqls().map((sql) => sql.split(' ')[0])).toEqual(['INSERT', 'SELECT']);
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 31 });
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 31 });
  });

  it('se criar a carteira falha, o erro sobe e nada é lido', async () => {
    const boom = new Error('ER_NO_REFERENCED_ROW_2');
    fakeDb.reply(boom);

    await expect(walletRepository.getOrCreate(999)).rejects.toBe(boom);

    expect(fakeDb.calls).toHaveLength(1);
  });

  it('getOrCreate cria a carteira só se faltar (uma por usuário) e devolve a linha dela', async () => {
    const wallet = { id: 2, user_id: 7, balance: '0.00', balance_pending: '0.00' };
    fakeDb.reply({ affectedRows: 0 }, [wallet]);

    expect(await walletRepository.getOrCreate(7)).toBe(wallet);

    // INSERT IGNORE: quem já tem carteira não ganha outra nem dá erro de chave duplicada.
    expect(fakeDb.calls[0]!.sql).toBe('INSERT IGNORE INTO wallets (user_id) VALUES (:userId)');
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    expect(fakeDb.calls[1]!.sql).toContain(
      'SELECT id, user_id, balance, balance_pending, currency, credits_balance, credits_pending FROM wallets WHERE user_id = :userId LIMIT 1',
    );
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 7 });
    expect(fakeDb.calls).toHaveLength(2);
  });
});
