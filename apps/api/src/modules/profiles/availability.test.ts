import { describe, expect, it } from 'vitest';
import {
  brtClock,
  currentSlot,
  isAvailableNow,
  normalizePeriods,
  parsePeriods,
  periodAt,
} from './availability';

// 2026-09-14 é segunda-feira. Brasília = UTC-3.
const at = (isoUtc: string): Date => new Date(isoUtc);

describe('relógio de Brasília e períodos (ADR 34)', () => {
  it('brtClock converte do UTC, inclusive virando o dia para trás', () => {
    expect(brtClock(at('2026-09-14T15:00:00Z'))).toEqual({ day: 1, hour: 12 });
    // 01:30 UTC de terça = 22:30 de segunda em Brasília
    expect(brtClock(at('2026-09-15T01:30:00Z'))).toEqual({ day: 1, hour: 22 });
  });

  it('periodAt: manhã 6–12, tarde 12–18, noite 18–24; madrugada não é período', () => {
    expect(periodAt(5)).toBeNull();
    expect(periodAt(6)).toBe('morning');
    expect(periodAt(11)).toBe('morning');
    expect(periodAt(12)).toBe('afternoon');
    expect(periodAt(17)).toBe('afternoon');
    expect(periodAt(18)).toBe('evening');
    expect(periodAt(23)).toBe('evening');
    expect(periodAt(0)).toBeNull();
  });

  it('currentSlot junta dia e período', () => {
    expect(currentSlot(at('2026-09-14T13:00:00Z'))).toEqual({ day: 1, period: 'morning' });
    expect(currentSlot(at('2026-09-14T06:00:00Z'))).toEqual({ day: 1, period: null }); // 03h
    expect(currentSlot(at('2026-09-20T22:00:00Z'))).toEqual({ day: 0, period: 'evening' }); // dom 19h
  });
});

describe('períodos por dia: leitura e normalização', () => {
  it('parsePeriods aceita objeto ou string e descarta o que não é válido', () => {
    expect(parsePeriods({ '1': ['afternoon', 'morning'] })).toEqual({
      '1': ['morning', 'afternoon'],
    });
    expect(parsePeriods('{"6":["evening","xyz"]}')).toEqual({ '6': ['evening'] });
    expect(parsePeriods({ '9': ['morning'], '2': 'morning', '3': [] })).toBeNull();
    expect(parsePeriods('{quebrado')).toBeNull();
    expect(parsePeriods(['morning'])).toBeNull();
    expect(parsePeriods(null)).toBeNull();
  });

  it('normalizePeriods: só dias marcados, sem repetição, em ordem; nenhum ou os três = o dia todo', () => {
    expect(
      normalizePeriods([1, 3, 5], {
        '1': ['afternoon', 'morning', 'morning'],
        '3': ['morning', 'afternoon', 'evening'], // os três → dia todo, sai
        '5': [],
        '2': ['evening'], // dia não marcado, sai
      }),
    ).toBe('{"1":["morning","afternoon"]}');
    expect(normalizePeriods([6], { '6': ['evening'] })).toBe('{"6":["evening"]}');
    expect(normalizePeriods([1], { '1': ['morning', 'afternoon', 'evening'] })).toBeNull();
    expect(normalizePeriods(null, { '1': ['morning'] })).toBeNull();
    expect(normalizePeriods([1, 2], null)).toBeNull();
  });
});

describe('isAvailableNow', () => {
  const MON_10H = at('2026-09-14T13:00:00Z'); // segunda, manhã
  const MON_20H = at('2026-09-14T23:00:00Z'); // segunda, noite
  const MON_03H = at('2026-09-14T06:00:00Z'); // segunda, madrugada
  const weekdays = [1, 2, 3, 4, 5];

  it('dia marcado sem períodos vale o dia todo (menos de madrugada)', () => {
    const a = { isAvailable: true, availableDays: weekdays, availablePeriods: null };
    expect(isAvailableNow(a, MON_10H)).toBe(true);
    expect(isAvailableNow(a, MON_20H)).toBe(true);
    expect(isAvailableNow(a, MON_03H)).toBe(false);
  });

  it('com períodos, só dentro deles; outro dia sem chave continua o dia todo', () => {
    const a = {
      isAvailable: true,
      availableDays: weekdays,
      availablePeriods: { '1': ['morning' as const] },
    };
    expect(isAvailableNow(a, MON_10H)).toBe(true);
    expect(isAvailableNow(a, MON_20H)).toBe(false);
    expect(isAvailableNow(a, at('2026-09-15T23:00:00Z'))).toBe(true); // terça 20h
  });

  it('pausado, sem dias ou fora dos dias: não atende agora', () => {
    expect(
      isAvailableNow(
        { isAvailable: false, availableDays: weekdays, availablePeriods: null },
        MON_10H,
      ),
    ).toBe(false);
    expect(
      isAvailableNow({ isAvailable: true, availableDays: null, availablePeriods: null }, MON_10H),
    ).toBe(false);
    expect(
      isAvailableNow({ isAvailable: true, availableDays: [0, 6], availablePeriods: null }, MON_10H),
    ).toBe(false);
  });
});
