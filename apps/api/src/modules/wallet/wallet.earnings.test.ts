import { describe, expect, it } from 'vitest';
import {
  bucketKeys,
  bucketOf,
  defaultFrom,
  earningsQuerySchema,
  MAX_BUCKETS,
  mondayOf,
  reasonList,
  resolveEarningsPeriod,
  summarizeEarnings,
  type EarningEntry,
} from './wallet.earnings';

let nextId = 1;
const entry = (
  at: string,
  amount: number,
  contractId: number | null = 1,
  reason: EarningEntry['reason'] = 'escrow_release',
): EarningEntry => ({ id: nextId++, amount, reason, contractId, createdAt: new Date(at) });

/** Ganhos por período (RF-082): a conta pura, sem banco. */
describe('períodos do gráfico', () => {
  it('a semana começa na segunda: domingo fica na semana que começou seis dias antes', () => {
    expect(mondayOf('2026-10-19')).toBe('2026-10-19'); // segunda
    expect(mondayOf('2026-10-25')).toBe('2026-10-19'); // domingo
    expect(mondayOf('2026-10-01')).toBe('2026-09-28'); // quinta, semana que vira o mês
    expect(mondayOf('2027-01-01')).toBe('2026-12-28'); // e o ano
  });

  it('o período de um dia em cada agrupamento', () => {
    expect(bucketOf('2026-10-07', 'day')).toBe('2026-10-07');
    expect(bucketOf('2026-10-07', 'week')).toBe('2026-10-05');
    expect(bucketOf('2026-10-07', 'month')).toBe('2026-10');
  });

  it('todos os períodos entre from e to, inclusive os das pontas parciais', () => {
    expect(bucketKeys('2026-09-29', '2026-10-02', 'day')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(bucketKeys('2026-10-01', '2026-10-19', 'week')).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(bucketKeys('2025-11-15', '2026-02-01', 'month')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('para de contar logo depois do teto, sem montar a lista inteira', () => {
    expect(bucketKeys('2020-01-01', '2026-12-31', 'day', 10)).toHaveLength(11);
  });

  it('padrão até `to`: 30 dias, 12 semanas inteiras ou 12 meses inteiros', () => {
    expect(defaultFrom('2026-10-19', 'day')).toBe('2026-09-20');
    expect(defaultFrom('2026-10-21', 'week')).toBe('2026-08-03'); // segunda, 11 semanas antes
    expect(defaultFrom('2026-10-19', 'month')).toBe('2025-11-01');
    expect(bucketKeys(defaultFrom('2026-10-21', 'week'), '2026-10-21', 'week')).toHaveLength(12);
    expect(bucketKeys(defaultFrom('2026-10-19', 'month'), '2026-10-19', 'month')).toHaveLength(12);
    expect(bucketKeys(defaultFrom('2026-10-19', 'day'), '2026-10-19', 'day')).toHaveLength(30);
  });
});

describe('resolveEarningsPeriod', () => {
  const q = (over: Record<string, unknown> = {}) => earningsQuerySchema.parse(over);

  it('sem nada: os últimos 12 meses até hoje, por mês', () => {
    expect(resolveEarningsPeriod(q(), '2026-10-19')).toMatchObject({
      from: '2025-11-01',
      to: '2026-10-19',
    });
  });

  it('só "até": o padrão do agrupamento termina nele; só "de": vai até hoje', () => {
    expect(
      resolveEarningsPeriod(q({ to: '2026-06-30', granularity: 'day' }), '2026-10-19'),
    ).toMatchObject({
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(
      resolveEarningsPeriod(q({ from: '2026-10-01', granularity: 'week' }), '2026-10-19'),
    ).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-19',
    });
  });

  it('invertido é 400 invalid_range, como no extrato; "de" no futuro sem "até" também', () => {
    for (const query of [q({ from: '2026-10-02', to: '2026-10-01' }), q({ from: '2026-11-01' })]) {
      expect(() => resolveEarningsPeriod(query, '2026-10-19')).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'invalid_range' }),
      );
    }
  });

  it('mais de 400 períodos é 400 range_too_long, com a unidade do agrupamento', () => {
    expect(() =>
      resolveEarningsPeriod(
        q({ from: '2025-01-01', to: '2026-10-19', granularity: 'day' }),
        '2026-10-19',
      ),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: 'range_too_long',
        message: `Período longo demais: no máximo ${MAX_BUCKETS} dias por gráfico`,
      }),
    );
    // O mesmo período por semana cabe.
    expect(
      resolveEarningsPeriod(
        q({ from: '2025-01-01', to: '2026-10-19', granularity: 'week' }),
        '2026-10-19',
      ).keys,
    ).toHaveLength(95);
  });

  it('a query valida dia de calendário e o agrupamento', () => {
    expect(earningsQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(earningsQuerySchema.safeParse({ granularity: 'year' }).success).toBe(false);
    expect(earningsQuerySchema.parse({}).granularity).toBe('month');
  });
});

describe('summarizeEarnings', () => {
  it('soma por dia no fuso da conta: a mesma linha cai em dias diferentes em Manaus e em Brasília', () => {
    // 01/10 03:30 UTC = 30/09 23:30 em Manaus, 01/10 00:30 em Brasília.
    const rows = [entry('2026-10-01T03:30:00Z', 100, 1)];
    const keys = ['2026-09-30', '2026-10-01'];

    const manaus = summarizeEarnings(rows, 'America/Manaus', 'day', keys);
    const brasilia = summarizeEarnings(rows, 'America/Sao_Paulo', 'day', keys);

    expect(manaus.series.map((b) => b.amount)).toEqual([100, 0]);
    expect(brasilia.series.map((b) => b.amount)).toEqual([0, 100]);
  });

  it('fronteira da semana e do mês no fuso: domingo 23:59 local é da semana (e do mês) que acaba', () => {
    // Dom 04/10/2026 23:59 em Brasília = seg 05/10 02:59 UTC; 31/10 23:59 = 01/11 02:59 UTC.
    const rows = [
      entry('2026-10-05T02:59:00Z', 10, 1),
      entry('2026-10-05T03:00:00Z', 20, 2), // segunda 00:00 local
      entry('2026-11-01T02:59:00Z', 30, 3),
      entry('2026-11-01T03:00:00Z', 40, 4),
    ];

    const weeks = summarizeEarnings(rows, 'America/Sao_Paulo', 'week', [
      '2026-09-28',
      '2026-10-05',
      '2026-10-26',
    ]);
    expect(weeks.series.map((b) => [b.bucket, b.amount])).toEqual([
      ['2026-09-28', 10],
      ['2026-10-05', 20],
      ['2026-10-26', 70],
    ]);

    const months = summarizeEarnings(rows, 'America/Sao_Paulo', 'month', ['2026-10', '2026-11']);
    expect(months.series.map((b) => b.amount)).toEqual([60, 40]);
  });

  it('total, contratações distintas, trocas e ticket médio; marcos da mesma contratação contam uma vez', () => {
    const rows = [
      entry('2026-10-01T15:00:00Z', 100, 7), // marco 1 da contratação 7
      entry('2026-10-02T15:00:00Z', 150, 7), // marco 2 da mesma
      entry('2026-10-02T16:00:00Z', 40.1, 8), // liberação parcial de um cancelamento
      entry('2026-10-02T17:00:00Z', 85, null, 'barter_in'), // torna recebida, já sem a taxa
    ];

    const out = summarizeEarnings(rows, 'America/Sao_Paulo', 'day', ['2026-10-01', '2026-10-02']);

    expect(out.series).toEqual([
      { bucket: '2026-10-01', amount: 100, contracts: 1, barters: 0 },
      { bucket: '2026-10-02', amount: 275.1, contracts: 2, barters: 1 },
    ]);
    // 375,10 ÷ (2 contratações + 1 troca) = 125,03
    expect(out.totals).toEqual({ amount: 375.1, contracts: 2, barters: 1, averageTicket: 125.03 });
  });

  it('centavos sem erro de ponto flutuante', () => {
    const rows = [0.1, 0.2, 0.7].map((v, i) => entry('2026-10-01T15:00:00Z', v, i + 1));
    const out = summarizeEarnings(rows, 'America/Sao_Paulo', 'month', ['2026-10']);
    expect(out.totals.amount).toBe(1);
    expect(out.series[0]!.amount).toBe(1);
  });

  it('liberação sem contratação (apagada) conta como um pagamento à parte', () => {
    const rows = [entry('2026-10-01T15:00:00Z', 50, null), entry('2026-10-01T16:00:00Z', 50, null)];
    expect(summarizeEarnings(rows, 'America/Sao_Paulo', 'month', ['2026-10']).totals).toMatchObject(
      {
        contracts: 2,
        averageTicket: 50,
      },
    );
  });

  it('sem ganho: zeros em todos os períodos e ticket médio nulo', () => {
    const out = summarizeEarnings([], 'America/Sao_Paulo', 'month', ['2026-09', '2026-10']);
    expect(out.series).toEqual([
      { bucket: '2026-09', amount: 0, contracts: 0, barters: 0 },
      { bucket: '2026-10', amount: 0, contracts: 0, barters: 0 },
    ]);
    expect(out.totals).toEqual({ amount: 0, contracts: 0, barters: 0, averageTicket: null });
  });

  it('linha fora dos períodos pedidos não entra (guarda além do filtro da consulta)', () => {
    const out = summarizeEarnings(
      [entry('2026-12-01T15:00:00Z', 99)],
      'America/Sao_Paulo',
      'month',
      ['2026-10'],
    );
    expect(out.totals.amount).toBe(0);
  });

  it('a lista de motivos do SQL sai das constantes', () => {
    expect(reasonList(['escrow_release', 'barter_in'])).toBe("('escrow_release', 'barter_in')");
  });
});
