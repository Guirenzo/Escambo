import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClockForTests } from '../../utils/clock';

vi.mock('./usage.repository', () => ({
  usageRepository: {
    countsByBucket: vi.fn(),
    activeByBucket: vi.fn(),
    activeTotal: vi.fn(),
    reviews: vi.fn(),
    snapshots: vi.fn(),
    existing: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock('./finance.repository', () => ({
  financeRepository: { ledgerByBucket: vi.fn(), contractsByBucket: vi.fn() },
}));

import { financeRepository } from './finance.repository';
import { usageRepository, type SnapshotRow, type UsageCountsRow } from './usage.repository';
import { ACTIVE_DEFINITION, usageService } from './usage.service';

const repo = vi.mocked(usageRepository);
const finance = vi.mocked(financeRepository);

const snap = (start: string, end: string, over: Record<string, number> = {}): SnapshotRow =>
  ({
    period_start: start,
    period_end: end,
    new_users: 10,
    new_contracts: 20,
    completed_contracts: 5,
    cancelled_contracts: 1,
    active_users: 40,
    ...over,
  }) as SnapshotRow;
const counts = (bucket: string, n: number): UsageCountsRow =>
  ({
    bucket,
    new_users: String(n),
    new_contracts: String(n * 2),
    completed_contracts: '1',
    cancelled_contracts: '0',
  }) as UsageCountsRow;

beforeEach(() => {
  vi.clearAllMocks();
  repo.snapshots.mockResolvedValue([]);
  repo.countsByBucket.mockResolvedValue([]);
  repo.activeByBucket.mockResolvedValue([]);
  repo.activeTotal.mockResolvedValue(0);
  repo.reviews.mockResolvedValue({ count: 0, avg: 0 });
  repo.insert.mockResolvedValue(true);
  finance.ledgerByBucket.mockResolvedValue([]);
  finance.contractsByBucket.mockResolvedValue([]);
});
afterEach(() => setClockForTests(null));

describe('usageService.report', () => {
  it('sem snapshot: tudo calculado agora, com todos os baldes do período (os zerados também)', async () => {
    repo.countsByBucket.mockResolvedValue([counts('2025-08-30', 2)]);
    repo.activeByBucket.mockResolvedValue([
      { bucket: '2025-08-30', active_users: '3' },
      { bucket: '2025-08-31', active_users: 1 },
    ] as never);
    repo.activeTotal.mockResolvedValue(4);

    const r = await usageService.report({
      from: '2025-08-29',
      to: '2025-08-31',
      granularity: 'day',
    });

    expect(repo.snapshots).toHaveBeenCalledWith('daily', '2025-08-29', '2025-08-31');
    const fromUtc = new Date('2025-08-29T03:00:00Z');
    const toUtc = new Date('2025-09-01T03:00:00Z');
    expect(repo.countsByBucket).toHaveBeenCalledWith(fromUtc, toUtc, 'day');
    expect(repo.activeByBucket).toHaveBeenCalledWith(fromUtc, toUtc, 'day');
    expect(repo.activeTotal).toHaveBeenCalledWith(fromUtc, toUtc);
    expect(r.series).toEqual([
      {
        bucket: '2025-08-29',
        source: 'live',
        newUsers: 0,
        newContracts: 0,
        completedContracts: 0,
        cancelledContracts: 0,
        activeUsers: 0,
      },
      {
        bucket: '2025-08-30',
        source: 'live',
        newUsers: 2,
        newContracts: 4,
        completedContracts: 1,
        cancelledContracts: 0,
        activeUsers: 3,
      },
      {
        bucket: '2025-08-31',
        source: 'live',
        newUsers: 0,
        newContracts: 0,
        completedContracts: 0,
        cancelledContracts: 0,
        activeUsers: 1,
      },
    ]);
    // Ativos no total: pessoas distintas no período (4), não a soma dos dias (3 + 1).
    expect(r.totals).toEqual({
      newUsers: 2,
      newContracts: 4,
      completedContracts: 1,
      cancelledContracts: 0,
      activeUsers: 4,
    });
    expect(r).toMatchObject({ from: '2025-08-29', to: '2025-08-31', granularity: 'day' });
    expect(r.activeDefinition).toBe(ACTIVE_DEFINITION);
  });

  it('balde inteiro com snapshot lê o snapshot; o cálculo de agora cobre só o que falta', async () => {
    // Semanas de 25/08, 01/09 e 08/09; o período corta a última (vai até 10/09).
    repo.snapshots.mockResolvedValue([
      snap('2025-08-25', '2025-08-31'),
      snap('2025-09-01', '2025-09-07', { active_users: 12 }),
    ]);
    repo.countsByBucket.mockResolvedValue([counts('2025-09-08', 1), counts('2025-08-25', 99)]);
    repo.activeTotal.mockResolvedValue(45);

    const r = await usageService.report({
      from: '2025-08-25',
      to: '2025-09-10',
      granularity: 'week',
    });

    expect(repo.snapshots).toHaveBeenCalledWith('weekly', '2025-08-25', '2025-09-08');
    // Só a semana cortada é calculada agora, e só dentro do período.
    expect(repo.countsByBucket).toHaveBeenCalledWith(
      new Date('2025-09-08T03:00:00Z'),
      new Date('2025-09-11T03:00:00Z'),
      'week',
    );
    expect(r.series.map((b) => [b.bucket, b.source, b.newUsers, b.activeUsers])).toEqual([
      ['2025-08-25', 'snapshot', 10, 40],
      ['2025-09-01', 'snapshot', 10, 12],
      ['2025-09-08', 'live', 1, 0],
    ]);
    expect(r.totals.newUsers).toBe(21);
    expect(r.totals.activeUsers).toBe(45);
  });

  it('snapshot de um balde cortado pelo período não serve: aquele balde é calculado agora', async () => {
    repo.snapshots.mockResolvedValue([snap('2025-08-01', '2025-08-31')]);
    repo.countsByBucket.mockResolvedValue([counts('2025-08', 3)]);

    const r = await usageService.report({
      from: '2025-08-15',
      to: '2025-08-31',
      granularity: 'month',
    });

    expect(repo.snapshots).toHaveBeenCalledWith('monthly', '2025-08-01', '2025-08-01');
    expect(repo.countsByBucket).toHaveBeenCalledWith(
      new Date('2025-08-15T03:00:00Z'),
      new Date('2025-09-01T03:00:00Z'),
      'month',
    );
    expect(r.series).toEqual([expect.objectContaining({ bucket: '2025-08', source: 'live' })]);
    expect(r.series[0]!.newUsers).toBe(3);
  });

  it('tudo com snapshot: não calcula balde nenhum agora (só o total de ativos)', async () => {
    repo.snapshots.mockResolvedValue([
      snap('2025-08-30', '2025-08-30'),
      snap('2025-08-31', '2025-08-31'),
    ]);

    const r = await usageService.report({
      from: '2025-08-30',
      to: '2025-08-31',
      granularity: 'day',
    });

    expect(repo.countsByBucket).not.toHaveBeenCalled();
    expect(repo.activeByBucket).not.toHaveBeenCalled();
    expect(repo.activeTotal).toHaveBeenCalledTimes(1);
    expect(r.series.every((b) => b.source === 'snapshot')).toBe(true);
    expect(r.totals.newContracts).toBe(40);
  });

  it('período inválido é 400 antes de consultar o banco', async () => {
    await expect(
      usageService.report({ from: '2025-09-02', to: '2025-09-01', granularity: 'day' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    expect(repo.snapshots).not.toHaveBeenCalled();
  });
});

describe('usageService.snapshot', () => {
  it('calcula o período inteiro (uso, receita do ledger, GMV e avaliações) e grava com o relógio do fluxo', async () => {
    const now = new Date('2025-09-01T03:20:00Z');
    setClockForTests(now, { frozen: true });
    repo.countsByBucket.mockResolvedValue([counts('2025-08-25', 2)]);
    repo.activeByBucket.mockResolvedValue([{ bucket: '2025-08-25', active_users: '6' }] as never);
    repo.reviews.mockResolvedValue({ count: 3, avg: 4.333 });
    finance.ledgerByBucket.mockResolvedValue([
      { bucket: '2025-08-25', revenue: '37.5', deposits: '300', withdrawals: '100', refunds: '50' },
    ] as never);
    finance.contractsByBucket.mockResolvedValue([
      { bucket: '2025-08-25', completed: 1, gmv: '200.00' },
    ] as never);

    expect(await usageService.snapshot('weekly', '2025-08-25', '2025-08-31')).toBe(true);

    const fromUtc = new Date('2025-08-25T03:00:00Z');
    const toUtc = new Date('2025-09-01T03:00:00Z');
    expect(repo.countsByBucket).toHaveBeenCalledWith(fromUtc, toUtc, 'week');
    expect(finance.ledgerByBucket).toHaveBeenCalledWith(fromUtc, toUtc, 'week');
    expect(finance.contractsByBucket).toHaveBeenCalledWith(fromUtc, toUtc, 'week');
    expect(repo.reviews).toHaveBeenCalledWith(fromUtc, toUtc);
    expect(repo.insert).toHaveBeenCalledWith({
      type: 'weekly',
      start: '2025-08-25',
      end: '2025-08-31',
      newUsers: 2,
      newContracts: 4,
      completedContracts: 1,
      cancelledContracts: 0,
      activeUsers: 6,
      platformFees: 37.5,
      totalRevenue: 200,
      avgRating: 4.33,
      payload: {
        version: 1,
        deposits: 300,
        withdrawals: 100,
        refunds: 50,
        completedCashContracts: 1,
        reviews: 3,
      },
      generatedAt: now,
    });
  });

  it('período sem movimento grava zeros; o mês usa a chave AAAA-MM; já gravado devolve false', async () => {
    repo.insert.mockResolvedValue(false);

    expect(await usageService.snapshot('monthly', '2025-08-01', '2025-08-31')).toBe(false);

    expect(repo.countsByBucket).toHaveBeenCalledWith(
      new Date('2025-08-01T03:00:00Z'),
      new Date('2025-09-01T03:00:00Z'),
      'month',
    );
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'monthly',
        newUsers: 0,
        activeUsers: 0,
        platformFees: 0,
        totalRevenue: 0,
        avgRating: 0,
        payload: expect.objectContaining({ deposits: 0, completedCashContracts: 0, reviews: 0 }),
      }),
    );
  });

  it('dia: chave AAAA-MM-DD e granularidade diária', async () => {
    repo.countsByBucket.mockResolvedValue([counts('2025-08-31', 5)]);
    await usageService.snapshot('daily', '2025-08-31', '2025-08-31');
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ newUsers: 5 }));
    expect(finance.ledgerByBucket).toHaveBeenCalledWith(
      new Date('2025-08-31T03:00:00Z'),
      new Date('2025-09-01T03:00:00Z'),
      'day',
    );
  });
});
