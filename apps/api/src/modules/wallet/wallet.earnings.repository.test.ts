import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { earningsRepository } from './wallet.earnings.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const range = {
  from: new Date('2026-10-01T03:00:00.000Z'),
  to: new Date('2026-11-01T03:00:00.000Z'),
};

/** Leituras dos ganhos (RF-082) sem banco: só SELECT, do usuário pedido, com os motivos certos. */
describe('earningsRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('linhas de ganho em R$: só liberação e torna com valor positivo, do usuário, no período', async () => {
    const rows = [{ id: 1, amount: '100.00', reason: 'escrow_release' }];
    fakeDb.reply(rows);

    expect(await earningsRepository.moneyEntries(7, range)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      "SELECT id, amount, reason, contract_id, created_at FROM wallet_transactions WHERE user_id = :userId AND reason IN ('escrow_release', 'barter_in') AND amount > 0 AND created_at >= :from AND created_at < :to ORDER BY id ASC",
    );
    expect(params).toEqual({ userId: 7, ...range });
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
  });

  it('créditos: soma do total do freelancer e contratações aceitas no período', async () => {
    fakeDb.reply([{ total: '-3', contracts: 2 }]);

    expect(await earningsRepository.creditTotals(7, range)).toEqual({ total: -3, contracts: 2 });

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      "FROM credit_transactions WHERE user_id = :userId AND reason IN ('escrow_in', 'escrow_release', 'escrow_refund') AND created_at >= :from AND created_at < :to",
    );
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN reason = 'escrow_in' THEN contract_id END)");
    expect(params).toEqual({ userId: 7, ...range });
  });

  it('créditos sem linha no período: zero', async () => {
    fakeDb.reply([]);
    expect(await earningsRepository.creditTotals(7, {})).toEqual({ total: 0, contracts: 0 });
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('já recebeu alguma vez: R$ liberado/torna ou créditos que entraram, em qualquer data', async () => {
    fakeDb.reply([{ has_earnings: 1 }], [{ has_earnings: 0 }], []);

    expect(await earningsRepository.hasEarnings(7)).toBe(true);
    expect(await earningsRepository.hasEarnings(8)).toBe(false);
    expect(await earningsRepository.hasEarnings(9)).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      "FROM wallet_transactions WHERE user_id = :userId AND reason IN ('escrow_release', 'barter_in') AND amount > 0",
    );
    expect(sql).toContain(
      "FROM credit_transactions WHERE user_id = :userId AND reason = 'escrow_in'",
    );
    expect(sql).not.toContain('created_at');
    expect(params).toEqual({ userId: 7 });
  });
});
