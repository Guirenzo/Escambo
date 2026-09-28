import type { BrazilTimezone } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import {
  addHumanHours,
  dayZones,
  floorSecond,
  humanize,
  inHumanHours,
  isHumanInstant,
  lastHumanAtOrBefore,
} from './human-hours';
import { BRAZIL_TIMEZONES, localParts } from './timezone';

/** Brasília é UTC−3: "2026-10-02 20:29:59" em Brasília. */
const brt = (s: string): Date => new Date(`${s.replace(' ', 'T')}-03:00`);
const SP: BrazilTimezone = 'America/Sao_Paulo';
const hm = (zone: BrazilTimezone, d: Date): string => {
  const p = localParts(zone, d);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
};

describe('hora humana (ADR 57)', () => {
  it('o portão dos jobs é [09:00, 21:00) no fuso', () => {
    expect(inHumanHours(SP, brt('2026-10-02 08:59:59'))).toBe(false);
    expect(inHumanHours(SP, brt('2026-10-02 09:00:00'))).toBe(true);
    expect(inHumanHours(SP, brt('2026-10-02 20:59:59'))).toBe(true);
    expect(inHumanHours(SP, brt('2026-10-02 21:00:00'))).toBe(false);
  });

  it('o mesmo instante é dia num fuso e noite em outro', () => {
    const at = new Date('2026-10-02T11:30:00Z'); // 09:30 em Noronha, 06:30 em Rio Branco
    expect(inHumanHours('America/Noronha', at)).toBe(true);
    expect(inHumanHours('America/Rio_Branco', at)).toBe(false);
  });

  it('dayZones às 12:00Z: Noronha (10h) e Brasília (9h) entram; Cuiabá, Manaus e Rio Branco não', () => {
    expect(dayZones(new Date('2026-10-02T12:00:00Z'))).toEqual([
      'America/Noronha',
      'America/Sao_Paulo',
    ]);
    expect(dayZones(new Date('2026-10-02T15:00:00Z'))).toEqual([...BRAZIL_TIMEZONES]);
    expect(dayZones(new Date('2026-10-02T03:00:00Z'))).toEqual([]);
  });

  it('humanize: fica na faixa [09:00, 20:30); fora dela vai para as 9h seguintes', () => {
    expect(hm(SP, humanize(brt('2026-10-02 20:29:59'), SP))).toBe('2026-10-02 20:29:59');
    expect(hm(SP, humanize(brt('2026-10-02 20:30:00'), SP))).toBe('2026-10-03 09:00:00');
    expect(hm(SP, humanize(brt('2026-10-02 23:59:59'), SP))).toBe('2026-10-03 09:00:00');
    expect(hm(SP, humanize(brt('2026-10-02 03:00:00'), SP))).toBe('2026-10-02 09:00:00');
    expect(hm(SP, humanize(brt('2026-10-02 09:00:00'), SP))).toBe('2026-10-02 09:00:00');
    expect(hm(SP, humanize(brt('2026-12-31 23:59:00'), SP))).toBe('2027-01-01 09:00:00');
  });

  it('humanize em Manaus usa as 9h de Manaus', () => {
    const at = new Date('2026-10-03T03:30:00Z'); // 23:30 em Manaus
    expect(hm('America/Manaus', humanize(at, 'America/Manaus'))).toBe('2026-10-03 09:00:00');
    expect(humanize(at, 'America/Manaus').toISOString()).toBe('2026-10-03T13:00:00.000Z');
  });

  it('lastHumanAtOrBefore: fora da faixa volta para as 20:29:59 anteriores', () => {
    expect(hm(SP, lastHumanAtOrBefore(brt('2026-10-02 21:30:00'), SP))).toBe('2026-10-02 20:29:59');
    expect(hm(SP, lastHumanAtOrBefore(brt('2026-10-02 07:00:00'), SP))).toBe('2026-10-01 20:29:59');
    expect(hm(SP, lastHumanAtOrBefore(brt('2026-10-02 23:59:59'), SP))).toBe('2026-10-02 20:29:59');
    expect(hm(SP, lastHumanAtOrBefore(brt('2026-10-02 15:00:00'), SP))).toBe('2026-10-02 15:00:00');
  });

  it('addHumanHours soma só o tempo de dia: recusa às 20:29 + 6 h = 14:59 do dia seguinte', () => {
    expect(hm(SP, addHumanHours(brt('2026-10-02 20:29:00'), 6, SP))).toBe('2026-10-03 14:59:00');
    expect(hm(SP, addHumanHours(brt('2026-10-02 10:00:00'), 6, SP))).toBe('2026-10-02 16:00:00');
    expect(hm(SP, addHumanHours(brt('2026-10-02 23:00:00'), 6, SP))).toBe('2026-10-03 15:00:00');
    // 11h30 por dia: 12 h a partir das 09:00 passam para as 09:30 do dia seguinte
    expect(hm(SP, addHumanHours(brt('2026-10-02 09:00:00'), 12, SP))).toBe('2026-10-03 09:30:00');
    expect(hm(SP, addHumanHours(brt('2026-10-02 12:00:00'), 0, SP))).toBe('2026-10-02 12:00:00');
  });

  it('floorSecond tira a fração (o DATETIME arredondaria)', () => {
    expect(floorSecond(new Date('2026-10-02T23:59:59.999Z')).toISOString()).toBe(
      '2026-10-02T23:59:59.000Z',
    );
  });

  it('propriedades em 1.000 instantes nos 5 fusos: nunca antes, sempre na faixa, idempotente', () => {
    let seed = 57;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 1000; i++) {
      const zone = BRAZIL_TIMEZONES[i % BRAZIL_TIMEZONES.length]!;
      const at = new Date(start + Math.floor(rand() * 400 * 86_400_000));
      const h = humanize(at, zone);
      expect(h.getTime()).toBeGreaterThanOrEqual(at.getTime());
      expect(h.getTime() - at.getTime()).toBeLessThan(13 * 3_600_000);
      expect(isHumanInstant(h, zone)).toBe(true);
      expect(humanize(h, zone).getTime()).toBe(h.getTime());
      const l = lastHumanAtOrBefore(at, zone);
      expect(l.getTime()).toBeLessThanOrEqual(at.getTime());
      expect(isHumanInstant(l, zone)).toBe(true);
      expect(humanize(l, zone).getTime()).toBe(l.getTime());
      const a = addHumanHours(at, 6, zone);
      expect(a.getTime()).toBeGreaterThanOrEqual(at.getTime() + 6 * 3_600_000);
      expect(isHumanInstant(a, zone)).toBe(true);
    }
  });
});
