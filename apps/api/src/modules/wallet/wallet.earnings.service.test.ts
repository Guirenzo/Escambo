import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wallet.earnings.repository', () => ({
  earningsRepository: { moneyEntries: vi.fn(), creditTotals: vi.fn(), hasEarnings: vi.fn() },
}));
vi.mock('../auth/user-zone', () => ({ userZone: vi.fn() }));

import { setClockForTests as setClock } from '../../utils/clock';
import { userZone } from '../auth/user-zone';
import { earningsQuerySchema } from './wallet.earnings';
import { earningsRepository } from './wallet.earnings.repository';
import { earningsService } from './wallet.earnings.service';

const repo = vi.mocked(earningsRepository);
const zone = vi.mocked(userZone);

/** Ganhos (RF-082): o fuso e o "hoje" de quem lê, o período em UTC e a resposta montada. */
describe('earningsService.report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.moneyEntries.mockResolvedValue([]);
    repo.creditTotals.mockResolvedValue({ total: 0, contracts: 0 });
    repo.hasEarnings.mockResolvedValue(false);
  });
  afterEach(() => setClock(null));

  it('o "hoje" do padrão é o do fuso da conta: 01/10 01:00 UTC ainda é 30/09 em Manaus', async () => {
    setClock(new Date('2026-10-01T01:00:00Z'), { frozen: true });
    zone.mockResolvedValue('America/Manaus');

    const out = await earningsService.report(7, earningsQuerySchema.parse({ granularity: 'day' }));

    expect(out).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'day',
      timezone: 'America/Manaus',
    });
    expect(out.series).toHaveLength(30);
    // O período vai ao banco em UTC: da meia-noite de 01/09 em Manaus (04:00 UTC) à de 01/10.
    expect(repo.moneyEntries).toHaveBeenCalledWith(7, {
      from: new Date('2026-09-01T04:00:00.000Z'),
      to: new Date('2026-10-01T04:00:00.000Z'),
    });
    expect(repo.creditTotals).toHaveBeenCalledWith(7, repo.moneyEntries.mock.calls[0]![1]);
    expect(repo.hasEarnings).toHaveBeenCalledWith(7);
  });

  it('monta a resposta com as linhas convertidas, os créditos à parte e se já recebeu alguma vez', async () => {
    setClock(new Date('2026-10-19T15:00:00Z'), { frozen: true });
    zone.mockResolvedValue('America/Sao_Paulo');
    repo.moneyEntries.mockResolvedValue([
      {
        id: 1,
        amount: '120.00',
        reason: 'escrow_release',
        contract_id: 5,
        created_at: new Date('2026-10-02T15:00:00Z'),
      },
      {
        id: 2,
        amount: '42.50',
        reason: 'barter_in',
        contract_id: null,
        created_at: new Date('2026-09-10T15:00:00Z'),
      },
    ] as never);
    repo.creditTotals.mockResolvedValue({ total: 8, contracts: 1 });
    repo.hasEarnings.mockResolvedValue(true);

    const out = await earningsService.report(
      7,
      earningsQuerySchema.parse({ from: '2026-09-01', to: '2026-10-31' }),
    );

    expect(out).toEqual({
      from: '2026-09-01',
      to: '2026-10-31',
      granularity: 'month',
      timezone: 'America/Sao_Paulo',
      hasEarnings: true,
      totals: { amount: 162.5, contracts: 1, barters: 1, averageTicket: 81.25 },
      series: [
        { bucket: '2026-09', amount: 42.5, contracts: 0, barters: 1 },
        { bucket: '2026-10', amount: 120, contracts: 1, barters: 0 },
      ],
      credits: { total: 8, contracts: 1 },
    });
  });

  it('período inválido é recusado antes de ir ao banco', async () => {
    zone.mockResolvedValue('America/Sao_Paulo');

    await expect(
      earningsService.report(
        7,
        earningsQuerySchema.parse({ from: '2026-10-02', to: '2026-10-01' }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    expect(repo.moneyEntries).not.toHaveBeenCalled();
  });
});
