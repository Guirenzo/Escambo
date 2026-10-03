import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('o dia vira às 3h UTC, meia-noite em Brasília', () => {
    expect(todayBrt(new Date('2026-09-14T02:59:59Z'))).toBe('2026-09-13');
    expect(todayBrt(new Date('2026-09-14T03:00:00Z'))).toBe('2026-09-14');
  });

  it('o padrão por mês atravessa a virada do ano: seis meses contando o atual, do dia 1º', () => {
    const now = new Date('2026-02-10T12:00:00Z');
    expect(defaultRange('month', now)).toEqual({ from: '2025-09-01', to: '2026-02-10' });
    expect(defaultRange('day', now)).toEqual({ from: '2026-01-12', to: '2026-02-10' });
  });

  it('período recusado é 400 e não consulta ledger, contratações nem carteiras', async () => {
    await expect(
      financeService.report({ from: '2026-09-10', to: '2026-09-01', granularity: 'day' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_range',
      message: 'Período inválido: a data inicial precisa ser até a final',
    });
    await expect(
      financeService.report({ from: '2024-01-01', to: '2026-09-01', granularity: 'month' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'range_too_long',
      message: 'Período máximo de 400 dias',
    });
    expect(repo.ledgerByBucket).not.toHaveBeenCalled();
    expect(repo.contractsByBucket).not.toHaveBeenCalled();
    expect(repo.snapshot).not.toHaveBeenCalled();
  });

  it('início um dia depois do fim já é período invertido', async () => {
    await expect(
      financeService.report({ from: '2026-09-02', to: '2026-09-01', granularity: 'day' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    expect(repo.ledgerByBucket).not.toHaveBeenCalled();
  });

  it('data no formato certo que não existe no calendário é período inválido, no início ou no fim', async () => {
    await expect(
      financeService.report({ from: '2026-13-01', to: '2026-09-30', granularity: 'day' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    await expect(
      financeService.report({ from: '2026-09-01', to: '2026-09-32', granularity: 'day' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    expect(repo.ledgerByBucket).not.toHaveBeenCalled();
    expect(repo.contractsByBucket).not.toHaveBeenCalled();
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
    // Balde só com contratação ou só com ledger: o que falta entra zerado, não ausente.
    expect(r.series[0]).toEqual({
      bucket: '2026-07',
      revenue: 0,
      deposits: 0,
      withdrawals: 0,
      refunds: 0,
      completedContracts: 2,
      gmv: 900,
    });
    expect(r.series[1]).toEqual({
      bucket: '2026-08',
      revenue: 45,
      deposits: 600,
      withdrawals: 100,
      refunds: 50,
      completedContracts: 0,
      gmv: 0,
    });
    // Mesmo recorte para o ledger e para as contratações: 01/07 a 30/09 em Brasília, fim exclusivo.
    const fromUtc = new Date('2026-07-01T03:00:00Z');
    const toUtc = new Date('2026-10-01T03:00:00Z');
    expect(repo.ledgerByBucket).toHaveBeenCalledWith(fromUtc, toUtc, '%Y-%m');
    expect(repo.contractsByBucket).toHaveBeenCalledWith(fromUtc, toUtc, '%Y-%m');
  });

  it('os valores saem em centavos: a soma dos baldes não carrega resto de ponto flutuante', async () => {
    repo.ledgerByBucket.mockResolvedValue([
      {
        bucket: '2026-09-01',
        revenue: '0.10',
        deposits: '0.10',
        withdrawals: '0.10',
        refunds: '0.10',
      },
      {
        bucket: '2026-09-02',
        revenue: '0.20',
        deposits: '0.20',
        withdrawals: '0.20',
        refunds: '0.20',
      },
    ] as never);
    // Contagem que chegar do driver como texto vira número: 1 + 2 soma 3, não "12".
    repo.contractsByBucket.mockResolvedValue([
      { bucket: '2026-09-01', completed: '1', gmv: '0.10' },
      { bucket: '2026-09-02', completed: '2', gmv: '0.20' },
    ] as never);

    const r = await financeService.report({
      from: '2026-09-01',
      to: '2026-09-02',
      granularity: 'day',
    });

    // 0,10 + 0,20 em ponto flutuante dá 0,30000000000000004.
    expect(r.totals).toEqual({
      revenue: 0.3,
      deposits: 0.3,
      withdrawals: 0.3,
      refunds: 0.3,
      completedContracts: 3,
      gmv: 0.3,
    });
    expect(r.series).toEqual([
      {
        bucket: '2026-09-01',
        revenue: 0.1,
        deposits: 0.1,
        withdrawals: 0.1,
        refunds: 0.1,
        completedContracts: 1,
        gmv: 0.1,
      },
      {
        bucket: '2026-09-02',
        revenue: 0.2,
        deposits: 0.2,
        withdrawals: 0.2,
        refunds: 0.2,
        completedContracts: 2,
        gmv: 0.2,
      },
    ]);
  });

  it('valor com mais de duas casas vindo do banco é arredondado para centavos em cada balde', async () => {
    repo.ledgerByBucket.mockResolvedValue([
      {
        bucket: '2026-09',
        revenue: '33.337',
        deposits: '0.004',
        withdrawals: '10.126',
        refunds: '5.551',
      },
    ] as never);
    repo.contractsByBucket.mockResolvedValue([
      { bucket: '2026-09', completed: 1, gmv: '99.999' },
    ] as never);

    const r = await financeService.report({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'month',
    });

    expect(r.series).toEqual([
      {
        bucket: '2026-09',
        revenue: 33.34,
        deposits: 0,
        withdrawals: 10.13,
        refunds: 5.55,
        completedContracts: 1,
        gmv: 100,
      },
    ]);
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

describe('financeService.report: recorte do período', () => {
  it('por dia, pede os baldes diários ao ledger e às contratações, nos mesmos instantes UTC', async () => {
    const r = await financeService.report({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'day',
    });

    const fromUtc = new Date('2026-09-01T03:00:00Z');
    const toUtc = new Date('2026-10-01T03:00:00Z');
    expect(repo.ledgerByBucket).toHaveBeenCalledWith(fromUtc, toUtc, '%Y-%m-%d');
    expect(repo.contractsByBucket).toHaveBeenCalledWith(fromUtc, toUtc, '%Y-%m-%d');
    expect(repo.snapshot).toHaveBeenCalledTimes(1);
    // O relatório diz o recorte que foi aplicado: o período e a granularidade pedidos, não o padrão.
    expect(r).toMatchObject({ from: '2026-09-01', to: '2026-09-30', granularity: 'day' });
    expect(r.now).toEqual({ inEscrow: 1200, usersBalance: 3400.5 });
    // Período sem movimento: série vazia e totais zerados, não erro.
    expect(r.series).toEqual([]);
    expect(r.totals).toEqual({
      revenue: 0,
      deposits: 0,
      withdrawals: 0,
      refunds: 0,
      completedContracts: 0,
      gmv: 0,
    });
  });
});

describe('financeService.exportCsv', () => {
  const row = {
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
  } as LedgerExportRow;

  afterEach(() => vi.useRealTimers());

  it('exporta o ledger do período pedido, com as datas de Brasília no nome do arquivo', async () => {
    repo.ledgerRows.mockResolvedValue([row]);

    const out = await financeService.exportCsv({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'month',
    });

    expect(out.fileName).toBe('escambo-ledger-2026-09-01_2026-09-30.csv');
    expect(repo.ledgerRows).toHaveBeenCalledTimes(1);
    // O fim é exclusivo: começo do dia seguinte ao último, em Brasília.
    expect(repo.ledgerRows).toHaveBeenCalledWith(
      new Date('2026-09-01T03:00:00Z'),
      new Date('2026-10-01T03:00:00Z'),
    );
    const lines = out.csv.split('\r\n');
    expect(lines[0]).toBe(
      '﻿id;data_hora_utc;usuario;motivo;valor_disponivel;valor_retido;disponivel_apos;retido_apos;contrato_id;pagamento_id;saque_id',
    );
    expect(lines[1]).toBe(
      '1;2026-09-10T12:00:00.000Z;ana@escambo.demo;deposit;250,00;0,00;250,00;0,00;;7;',
    );
    expect(lines).toHaveLength(3); // cabeçalho, uma linha e o CRLF final
  });

  it('sem período, exporta o padrão da granularidade até hoje em Brasília', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T01:30:00Z')); // 13/09 22:30 em Brasília
    repo.ledgerRows.mockResolvedValue([]);

    const byMonth = await financeService.exportCsv({ granularity: 'month' });
    expect(byMonth.fileName).toBe('escambo-ledger-2026-04-01_2026-09-13.csv');
    expect(repo.ledgerRows).toHaveBeenLastCalledWith(
      new Date('2026-04-01T03:00:00Z'),
      new Date('2026-09-14T03:00:00Z'),
    );

    const byDay = await financeService.exportCsv({ granularity: 'day' });
    expect(byDay.fileName).toBe('escambo-ledger-2026-08-15_2026-09-13.csv');
    expect(repo.ledgerRows).toHaveBeenLastCalledWith(
      new Date('2026-08-15T03:00:00Z'),
      new Date('2026-09-14T03:00:00Z'),
    );
    // Período sem lançamento: o arquivo sai só com o cabeçalho.
    expect(byDay.csv.split('\r\n')).toHaveLength(2);
  });

  it('período invertido ou acima de 400 dias é recusado antes de ler o ledger', async () => {
    await expect(
      financeService.exportCsv({ from: '2026-09-10', to: '2026-09-01', granularity: 'day' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_range' });
    await expect(
      financeService.exportCsv({ from: '2024-01-01', to: '2026-09-01', granularity: 'month' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'range_too_long' });
    expect(repo.ledgerRows).not.toHaveBeenCalled();
  });

  it('um dia só é período válido; exatamente 400 dias também, 401 não', async () => {
    repo.ledgerRows.mockResolvedValue([]);
    await financeService.exportCsv({ from: '2026-09-10', to: '2026-09-10', granularity: 'day' });
    expect(repo.ledgerRows).toHaveBeenLastCalledWith(
      new Date('2026-09-10T03:00:00Z'),
      new Date('2026-09-11T03:00:00Z'),
    );

    // 2025-01-01 a 2026-02-04 são 400 dias contando as duas pontas.
    await financeService.exportCsv({ from: '2025-01-01', to: '2026-02-04', granularity: 'day' });
    expect(repo.ledgerRows).toHaveBeenCalledTimes(2);
    await expect(
      financeService.exportCsv({ from: '2025-01-01', to: '2026-02-05', granularity: 'day' }),
    ).rejects.toMatchObject({ code: 'range_too_long' });
    expect(repo.ledgerRows).toHaveBeenCalledTimes(2);
  });
});
