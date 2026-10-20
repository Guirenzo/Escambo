import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existing, snapshot } = vi.hoisted(() => ({ existing: vi.fn(), snapshot: vi.fn() }));
vi.mock('../modules/admin/usage.repository', () => ({ usageRepository: { existing } }));
vi.mock('../modules/admin/usage.service', () => ({ usageService: { snapshot } }));

import { closedPeriods, runReportSnapshots, SNAPSHOT_MARGIN_MS } from './report-snapshots';

beforeEach(() => {
  vi.clearAllMocks();
  existing.mockResolvedValue(new Set());
  snapshot.mockResolvedValue(true);
});

/** 01/09/2025 (segunda) às 00:20 em Brasília: domingo 31/08 fechou a semana e o mês. */
const MONDAY_AFTER = new Date('2025-09-01T03:20:00Z');

describe('closedPeriods', () => {
  it('os últimos 7 dias fechados, a última semana inteira e o último mês inteiro', () => {
    const { closedDay, periods } = closedPeriods(MONDAY_AFTER);
    expect(closedDay).toBe('2025-08-31');
    expect(periods).toEqual([
      { type: 'daily', start: '2025-08-25', end: '2025-08-25' },
      { type: 'daily', start: '2025-08-26', end: '2025-08-26' },
      { type: 'daily', start: '2025-08-27', end: '2025-08-27' },
      { type: 'daily', start: '2025-08-28', end: '2025-08-28' },
      { type: 'daily', start: '2025-08-29', end: '2025-08-29' },
      { type: 'daily', start: '2025-08-30', end: '2025-08-30' },
      { type: 'daily', start: '2025-08-31', end: '2025-08-31' },
      { type: 'weekly', start: '2025-08-25', end: '2025-08-31' },
      { type: 'monthly', start: '2025-08-01', end: '2025-08-31' },
    ]);
  });

  it('no meio da semana e do mês, a semana e o mês são os anteriores, já fechados', () => {
    // Quarta 10/09/2025, 15h em Brasília: fechou terça 09/09.
    const { closedDay, periods } = closedPeriods(new Date('2025-09-10T18:00:00Z'));
    expect(closedDay).toBe('2025-09-09');
    expect(periods.slice(-2)).toEqual([
      { type: 'weekly', start: '2025-09-01', end: '2025-09-07' },
      { type: 'monthly', start: '2025-08-01', end: '2025-08-31' },
    ]);
  });

  it('logo depois da meia-noite, a folga ainda não dá o dia por fechado', () => {
    // 00:10 de 01/09 em Brasília: dentro da folga, o último dia fechado ainda é 30/08.
    const justAfter = new Date('2025-09-01T03:10:00Z');
    expect(closedPeriods(justAfter).closedDay).toBe('2025-08-30');
    const afterMargin = new Date(new Date('2025-09-01T03:00:00Z').getTime() + SNAPSHOT_MARGIN_MS);
    expect(closedPeriods(afterMargin).closedDay).toBe('2025-08-31');
  });
});

describe('runReportSnapshots', () => {
  it('grava o que falta, na ordem, e pula o que já está gravado', async () => {
    existing.mockResolvedValue(
      new Set([
        'daily:2025-08-25',
        'daily:2025-08-26',
        'daily:2025-08-27',
        'daily:2025-08-28',
        'daily:2025-08-29',
        'daily:2025-08-30',
      ]),
    );

    const r = await runReportSnapshots(MONDAY_AFTER);

    // Desde o começo do mês, o período mais antigo que a rodada confere.
    expect(existing).toHaveBeenCalledWith('2025-08-01');
    expect(snapshot.mock.calls).toEqual([
      ['daily', '2025-08-31', '2025-08-31'],
      ['weekly', '2025-08-25', '2025-08-31'],
      ['monthly', '2025-08-01', '2025-08-31'],
    ]);
    expect(r).toEqual({
      closedDay: '2025-08-31',
      written: ['daily:2025-08-31', 'weekly:2025-08-25', 'monthly:2025-08-01'],
      failed: [],
    });
  });

  it('rodar de novo com tudo gravado não calcula nada', async () => {
    const { periods } = closedPeriods(MONDAY_AFTER);
    existing.mockResolvedValue(new Set(periods.map((p) => `${p.type}:${p.start}`)));

    expect(await runReportSnapshots(MONDAY_AFTER)).toEqual({
      closedDay: '2025-08-31',
      written: [],
      failed: [],
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('outra instância gravou antes (false): não conta como gravado por esta', async () => {
    snapshot.mockResolvedValue(false);
    const r = await runReportSnapshots(MONDAY_AFTER);
    expect(r.written).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(9);
  });

  it('um período que falha não segura os outros e fica para a próxima rodada', async () => {
    snapshot.mockImplementation(async (type: string, start: string) => {
      if (type === 'weekly') throw new Error('ER_LOCK_WAIT_TIMEOUT');
      return start === '2025-08-31';
    });

    const r = await runReportSnapshots(MONDAY_AFTER);

    expect(r.failed).toEqual(['weekly:2025-08-25']);
    expect(r.written).toEqual(['daily:2025-08-31']);
    expect(snapshot).toHaveBeenCalledTimes(9);
  });

  it('sem o banco para conferir o que existe, o job falha inteiro (o agendador registra)', async () => {
    existing.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(runReportSnapshots(MONDAY_AFTER)).rejects.toThrow('ECONNREFUSED');
    expect(snapshot).not.toHaveBeenCalled();
  });
});
