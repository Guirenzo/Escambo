import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./finance.repository', () => ({
  financeRepository: {
    ledgerByBucket: vi.fn(),
    contractsByBucket: vi.fn(),
    snapshot: vi.fn(),
    ledgerRows: vi.fn(),
  },
}));

import { financeRepository, type LedgerExportRow } from './finance.repository';
import { bounds, defaultRange, financeService, toCsv, todayBrt } from './finance.service';

const repo = vi.mocked(financeRepository);

beforeEach(() => {
  vi.clearAllMocks();
  repo.snapshot.mockResolvedValue({ inEscrow: 1200, usersBalance: 3400.5 });
  repo.contractsByBucket.mockResolvedValue([]);
  repo.ledgerByBucket.mockResolvedValue([]);
});

describe('período', () => {
  it('dias de Brasília viram instantes UTC, com o fim exclusivo', () => {
    const { fromUtc, toUtc } = bounds('2026-09-01', '2026-09-30');
    expect(fromUtc.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it('padrão: 30 dias por dia, 6 meses por mês, sempre até hoje em Brasília', () => {
    const now = new Date('2026-09-14T01:30:00Z'); // 13/09 22:30 em Brasília
    expect(todayBrt(now)).toBe('2026-09-13');
    expect(defaultRange('day', now)).toEqual({ from: '2026-08-15', to: '2026-09-13' });
    expect(defaultRange('month', now)).toEqual({ from: '2026-04-01', to: '2026-09-13' });
  });

  it('recusa período invertido ou longo demais', async () => {
    await expect(
      financeService.report({ from: '2026-09-10', to: '2026-09-01', granularity: 'day' }),
    ).rejects.toMatchObject({ code: 'invalid_range' });
    await expect(
      financeService.report({ from: '2024-01-01', to: '2026-09-01', granularity: 'month' }),
    ).rejects.toMatchObject({ code: 'range_too_long' });
  });
});

describe('financeService.report', () => {
  it('junta ledger e contratações por balde, soma os totais e traz a fotografia de agora', async () => {
    repo.ledgerByBucket.mockResolvedValue([
      {
        bucket: '2026-08',
        revenue: '45.00',
        deposits: '600.00',
        withdrawals: '100.00',
        refunds: '50.00',
      },
      {
        bucket: '2026-09',
        revenue: '30.00',
        deposits: '300.00',
        withdrawals: '0.00',
        refunds: '0.00',
      },
    ] as never);
    repo.contractsByBucket.mockResolvedValue([
      { bucket: '2026-09', completed: 1, gmv: '200.00' },
      { bucket: '2026-07', completed: 2, gmv: '900.00' },
    ] as never);

    const r = await financeService.report({
      from: '2026-07-01',
      to: '2026-09-30',
      granularity: 'month',
    });

    expect(repo.ledgerByBucket).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), '%Y-%m');
    expect(r.series.map((b) => b.bucket)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(r.series[0]).toMatchObject({ revenue: 0, completedContracts: 2, gmv: 900 });
    expect(r.series[2]).toMatchObject({
      revenue: 30,
      deposits: 300,
      completedContracts: 1,
      gmv: 200,
    });
    expect(r.totals).toEqual({
      revenue: 75,
      deposits: 900,
      withdrawals: 100,
      refunds: 50,
      completedContracts: 3,
      gmv: 1100,
    });
    expect(r.now).toEqual({ inEscrow: 1200, usersBalance: 3400.5 });
    expect(r).toMatchObject({ from: '2026-07-01', to: '2026-09-30', granularity: 'month' });
  });
});

describe('toCsv', () => {
  it('BOM, ponto e vírgula, vírgula decimal e aspas só quando precisa', () => {
    const csv = toCsv([
      {
        id: 1,
        created_at: new Date('2026-09-10T12:00:00Z'),
        user_email: 'ana@escambo.demo',
        reason: 'deposit',
        amount: '250.00',
        pending_delta: '0.00',
        balance_after: '250.00',
        pending_after: '0.00',
        contract_id: null,
        payment_id: 7,
        withdrawal_id: null,
      },
      {
        id: 2,
        created_at: new Date('2026-09-10T12:05:00Z'),
        user_email: 'x;"y"@escambo.demo',
        reason: 'hold',
        amount: '-100.00',
        pending_delta: '100.00',
        balance_after: '150.00',
        pending_after: '100.00',
        contract_id: 3,
        payment_id: null,
        withdrawal_id: null,
      },
    ] as LedgerExportRow[]);
    const lines = csv.split('\r\n');
    expect(lines[0]!.startsWith('\uFEFFid;data_hora_utc;usuario;motivo;')).toBe(true);
    expect(lines[1]).toBe(
      '1;2026-09-10T12:00:00.000Z;ana@escambo.demo;deposit;250,00;0,00;250,00;0,00;;7;',
    );
    expect(lines[2]).toBe(
      '2;2026-09-10T12:05:00.000Z;"x;""y""@escambo.demo";hold;-100,00;100,00;150,00;100,00;3;;',
    );
  });
});
