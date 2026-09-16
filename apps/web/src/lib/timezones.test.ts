import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, TIMEZONE_OPTIONS, timezoneLabel } from './timezones';

describe('fusos do Brasil (ADR 46)', () => {
  it('oferece os cinco fusos, de leste para oeste, com Brasília como padrão', () => {
    expect(TIMEZONE_OPTIONS.map((o) => o.value)).toEqual([
      'America/Noronha',
      'America/Sao_Paulo',
      'America/Cuiaba',
      'America/Manaus',
      'America/Rio_Branco',
    ]);
    expect(TIMEZONE_OPTIONS.map((o) => o.value)).toContain(DEFAULT_TIMEZONE);
  });

  it('rótulo curto para as frases; fora da lista vale Brasília', () => {
    expect(timezoneLabel('America/Manaus')).toBe('Manaus');
    expect(timezoneLabel('America/Cuiaba')).toBe('Cuiabá e Campo Grande');
    expect(timezoneLabel(null)).toBe('Brasília');
    expect(timezoneLabel('Europe/Lisbon')).toBe('Brasília');
  });
});
