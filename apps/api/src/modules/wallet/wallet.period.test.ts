import type { BrazilTimezone } from '@escambo/types';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../utils/http-error';
import { isCalendarDay, periodRange } from './wallet.period';

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
