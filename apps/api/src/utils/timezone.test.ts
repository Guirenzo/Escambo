import { describe, expect, it } from 'vitest';
import {
  BRAZIL_TIMEZONES,
  DEFAULT_TIMEZONE,
  formatDateTime,
  hourIn,
  isBrazilTimezone,
  offsetMinutes,
  startOfTodayIn,
  timezoneOf,
} from './timezone';

const NOON_BRT = new Date('2026-09-14T15:00:00Z');

describe('fusos do Brasil (ADR 46)', () => {
  it('hora do dia e deslocamento em cada fuso', () => {
    expect(hourIn('America/Sao_Paulo', NOON_BRT)).toBe(12);
    expect(hourIn('America/Manaus', NOON_BRT)).toBe(11);
    expect(hourIn('America/Rio_Branco', NOON_BRT)).toBe(10);
    expect(hourIn('America/Noronha', NOON_BRT)).toBe(13);
    expect(hourIn('America/Sao_Paulo', new Date('2026-09-14T01:00:00Z'))).toBe(22);
    expect(offsetMinutes('America/Sao_Paulo', NOON_BRT)).toBe(-180);
    expect(offsetMinutes('America/Cuiaba', NOON_BRT)).toBe(-240);
    expect(offsetMinutes('America/Noronha', NOON_BRT)).toBe(-120);
    expect(offsetMinutes('America/Rio_Branco', NOON_BRT)).toBe(-300);
  });

  it('meia-noite de hoje é a do fuso, mesmo quando a data em UTC já virou', () => {
    expect(startOfTodayIn('America/Sao_Paulo', NOON_BRT).toISOString()).toBe(
      '2026-09-14T03:00:00.000Z',
    );
    expect(startOfTodayIn('America/Manaus', NOON_BRT).toISOString()).toBe(
      '2026-09-14T04:00:00.000Z',
    );
    // 01:00Z do dia 14: ainda dia 13 em Brasília (22:00) e em Noronha (23:00).
    const late = new Date('2026-09-14T01:00:00Z');
    expect(startOfTodayIn('America/Sao_Paulo', late).toISOString()).toBe(
      '2026-09-13T03:00:00.000Z',
    );
    expect(startOfTodayIn('America/Noronha', late).toISOString()).toBe('2026-09-13T02:00:00.000Z');
  });

  it('data nos avisos sai no fuso da pessoa', () => {
    const at = new Date('2026-09-29T15:00:00Z');
    expect(formatDateTime(at, 'America/Sao_Paulo')).toBe('29/09/2026 às 12:00');
    expect(formatDateTime(at, 'America/Manaus')).toBe('29/09/2026 às 11:00');
    expect(formatDateTime(new Date('2026-01-01T02:30:00Z'), 'America/Sao_Paulo')).toBe(
      '31/12/2025 às 23:30',
    );
  });

  it('só aceita fuso da lista; fora dela ou vazio vale Brasília', () => {
    expect(BRAZIL_TIMEZONES).toContain(DEFAULT_TIMEZONE);
    expect(isBrazilTimezone('America/Manaus')).toBe(true);
    expect(isBrazilTimezone('Europe/Lisbon')).toBe(false);
    expect(timezoneOf('America/Rio_Branco')).toBe('America/Rio_Branco');
    expect(timezoneOf('Europe/Lisbon')).toBe('America/Sao_Paulo');
    expect(timezoneOf(null)).toBe('America/Sao_Paulo');
  });
});
