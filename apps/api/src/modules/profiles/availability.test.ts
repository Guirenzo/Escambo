import { describe, expect, it } from 'vitest';
import {
  clockIn,
  currentSlot,
  isAvailableNow,
  normalizePeriods,
  parsePeriods,
  periodAt,
  slotsByZone,
} from './availability';

// 2026-09-14 é segunda-feira. Brasília = UTC−3, Manaus = UTC−4, Rio Branco = UTC−5, Noronha = UTC−2.
const at = (isoUtc: string): Date => new Date(isoUtc);

describe('relógio por fuso e períodos (ADR 34 e 48)', () => {
  it('clockIn converte do UTC no fuso pedido, inclusive virando o dia para trás', () => {
    expect(clockIn('America/Sao_Paulo', at('2026-09-14T15:00:00Z'))).toEqual({ day: 1, hour: 12 });
    // 01:30 UTC de terça = 22:30 de segunda em Brasília, 21:30 em Manaus, 20:30 em Rio Branco
    expect(clockIn('America/Sao_Paulo', at('2026-09-15T01:30:00Z'))).toEqual({ day: 1, hour: 22 });
    expect(clockIn('America/Manaus', at('2026-09-15T01:30:00Z'))).toEqual({ day: 1, hour: 21 });
    expect(clockIn('America/Rio_Branco', at('2026-09-15T01:30:00Z'))).toEqual({ day: 1, hour: 20 });
    // 02:30 UTC de terça já é terça em Noronha (00:30)
    expect(clockIn('America/Noronha', at('2026-09-15T02:30:00Z'))).toEqual({ day: 2, hour: 0 });
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

  it('currentSlot junta dia e período; sem fuso é Brasília', () => {
    expect(currentSlot(at('2026-09-14T13:00:00Z'))).toEqual({ day: 1, period: 'morning' });
    expect(currentSlot(at('2026-09-14T06:00:00Z'))).toEqual({ day: 1, period: null }); // 03h
    expect(currentSlot(at('2026-09-20T22:00:00Z'))).toEqual({ day: 0, period: 'evening' }); // dom 19h
    // 15:30 UTC: 12:30 em Brasília (tarde), 11:30 em Manaus (manhã)
    expect(currentSlot(at('2026-09-14T15:30:00Z'), 'America/Manaus')).toEqual({
      day: 1,
      period: 'morning',
    });
  });

  it('slotsByZone dá o agora de cada fuso do país', () => {
    // 10:30 UTC de segunda: 08:30 Noronha, 07:30 Brasília, 06:30 Cuiabá/Manaus, 05:30 Rio Branco
    expect(slotsByZone(at('2026-09-14T10:30:00Z'))).toEqual({
      'America/Noronha': { day: 1, period: 'morning' },
      'America/Sao_Paulo': { day: 1, period: 'morning' },
      'America/Cuiaba': { day: 1, period: 'morning' },
      'America/Manaus': { day: 1, period: 'morning' },
      'America/Rio_Branco': { day: 1, period: null },
    });
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
  const MON_10H = at('2026-09-14T13:00:00Z'); // segunda, manhã em Brasília
  const MON_20H = at('2026-09-14T23:00:00Z'); // segunda, noite em Brasília
  const MON_03H = at('2026-09-14T06:00:00Z'); // segunda, madrugada em Brasília
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

  it('a agenda vale no fuso do freelancer (ADR 48)', () => {
    const mornings = {
      isAvailable: true,
      availableDays: weekdays,
      availablePeriods: { '1': ['morning' as const] },
    };
    // 15:30 UTC: 12:30 em Brasília (tarde, fora), 11:30 em Manaus (manhã, dentro)
    const t = at('2026-09-14T15:30:00Z');
    expect(isAvailableNow(mornings, t)).toBe(false);
    expect(isAvailableNow({ ...mornings, timezone: 'America/Manaus' }, t)).toBe(true);
    expect(isAvailableNow({ ...mornings, timezone: 'America/Rio_Branco' }, t)).toBe(true);
    // 09:30 UTC: 06:30 em Brasília (manhã), 04:30 em Rio Branco (madrugada)
    const early = at('2026-09-14T09:30:00Z');
    expect(isAvailableNow(mornings, early)).toBe(true);
    expect(isAvailableNow({ ...mornings, timezone: 'America/Rio_Branco' }, early)).toBe(false);
    // Fuso desconhecido ou nulo cai em Brasília.
    expect(isAvailableNow({ ...mornings, timezone: 'Europe/Lisbon' }, t)).toBe(false);
    expect(isAvailableNow({ ...mornings, timezone: null }, early)).toBe(true);
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
