import type { BrazilTimezone } from '@escambo/types';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../utils/http-error';
import {
  isCalendarDay,
  ledgerPage,
  ledgerQuerySchema,
  periodRange,
  rangeFilter,
} from './wallet.period';

const zone = (z: BrazilTimezone) => vi.fn(async () => z);

/** Período do extrato de R$ (RF-047): dias no fuso de quem lê viram instantes UTC. */
describe('isCalendarDay', () => {
  it.each(['2026-10-01', '2026-02-28', '2028-02-29', '2026-12-31'])('%s é um dia', (day) => {
    expect(isCalendarDay(day)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '2026-10-32',
    '2026-1-01',
    '01/10/2026',
    '2026-10-01T00:00:00Z',
    '',
    '0099-01-01',
  ])('"%s" não é um dia', (day) => {
    expect(isCalendarDay(day)).toBe(false);
  });
});

describe('periodRange', () => {
  it('sem período: extrato inteiro, sem nem buscar o fuso da conta', async () => {
    const zoneOf = zone('America/Sao_Paulo');
    expect(await periodRange({}, zoneOf)).toEqual({});
    expect(await periodRange({ from: undefined, to: undefined }, zoneOf)).toEqual({});
    expect(zoneOf).not.toHaveBeenCalled();
  });

  it('em Brasília, de 01/10 até 02/10 vai das 03:00 UTC de 01/10 às 03:00 UTC de 03/10 (o "até" inclui o dia)', async () => {
    const zoneOf = zone('America/Sao_Paulo');
    expect(await periodRange({ from: '2026-10-01', to: '2026-10-02' }, zoneOf)).toEqual({
      from: new Date('2026-10-01T03:00:00.000Z'),
      to: new Date('2026-10-03T03:00:00.000Z'),
    });
    expect(zoneOf).toHaveBeenCalledTimes(1);
  });

  it('o dia é o do fuso de quem lê: em Manaus começa às 04:00 UTC, em Noronha às 02:00 UTC', async () => {
    expect(
      await periodRange({ from: '2026-10-01', to: '2026-10-01' }, zone('America/Manaus')),
    ).toEqual({
      from: new Date('2026-10-01T04:00:00.000Z'),
      to: new Date('2026-10-02T04:00:00.000Z'),
    });
    expect(
      await periodRange({ from: '2026-10-01', to: '2026-10-01' }, zone('America/Noronha')),
    ).toEqual({
      from: new Date('2026-10-01T02:00:00.000Z'),
      to: new Date('2026-10-02T02:00:00.000Z'),
    });
  });

  it('só o início ou só o fim: o outro lado fica aberto; o fim do mês vira o 1º do mês seguinte', async () => {
    expect(await periodRange({ from: '2026-09-15' }, zone('America/Rio_Branco'))).toEqual({
      from: new Date('2026-09-15T05:00:00.000Z'),
    });
    expect(await periodRange({ to: '2026-09-30' }, zone('America/Sao_Paulo'))).toEqual({
      to: new Date('2026-10-01T03:00:00.000Z'),
    });
    expect(await periodRange({ to: '2026-12-31' }, zone('America/Sao_Paulo'))).toEqual({
      to: new Date('2027-01-01T03:00:00.000Z'),
    });
  });

  it('período invertido é recusado com 400 invalid_range, antes de buscar o fuso', async () => {
    const zoneOf = zone('America/Sao_Paulo');
    const err = await periodRange({ from: '2026-10-02', to: '2026-10-01' }, zoneOf).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({
      statusCode: 400,
      message: 'Período inválido: a data inicial precisa ser até a final',
      code: 'invalid_range',
    });
    expect(zoneOf).not.toHaveBeenCalled();
  });
});

/** O que os dois extratos (R$ e créditos) dividem: a query, o filtro SQL e a página com "mais". */
describe('ledgerQuerySchema (query dos extratos)', () => {
  it('página 1 e 20 por página por padrão; período opcional, em dias que existem', () => {
    expect(ledgerQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(
      ledgerQuerySchema.parse({ page: '2', limit: '50', from: '2026-10-01', to: '2026-10-15' }),
    ).toEqual({ page: 2, limit: 50, from: '2026-10-01', to: '2026-10-15' });
  });

  it.each([
    [{ from: '2026-02-30' }, 'from'],
    [{ to: '01/10/2026' }, 'to'],
    [{ limit: '101' }, 'limit'],
    [{ page: '10001' }, 'page'],
  ])('%o é recusado no campo %s', (query, field) => {
    const parsed = ledgerQuerySchema.safeParse(query);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual([field]);
  });
});

describe('rangeFilter (filtro SQL do período)', () => {
  const from = new Date('2026-10-01T03:00:00.000Z');
  const to = new Date('2026-10-03T03:00:00.000Z');

  it('sem período, nada; com os dois lados, início inclusivo e fim exclusivo', () => {
    expect(rangeFilter({})).toEqual({ sql: '', params: {} });
    expect(rangeFilter({ from, to })).toEqual({
      sql: ' AND created_at >= :from AND created_at < :to',
      params: { from, to },
    });
  });

  it('só um lado: só ele entra', () => {
    expect(rangeFilter({ from })).toEqual({ sql: ' AND created_at >= :from', params: { from } });
    expect(rangeFilter({ to })).toEqual({ sql: ' AND created_at < :to', params: { to } });
  });
});

describe('ledgerPage (página com "Carregar mais")', () => {
  it('com uma linha a mais que o limite, ela fica de fora e diz que há outra página', () => {
    expect(ledgerPage([3, 2, 1], 1, 2, (n) => n * 10)).toEqual({
      items: [30, 20],
      page: 1,
      limit: 2,
      hasMore: true,
    });
  });

  it('página cheia sem sobra, ou curta, é a última', () => {
    expect(ledgerPage([2, 1], 3, 2, String)).toEqual({
      items: ['2', '1'],
      page: 3,
      limit: 2,
      hasMore: false,
    });
    expect(ledgerPage([], 1, 20, String)).toEqual({
      items: [],
      page: 1,
      limit: 20,
      hasMore: false,
    });
  });
});
