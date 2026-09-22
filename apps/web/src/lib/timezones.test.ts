import { describe, expect, it } from 'vitest';
import {
  brazilZoneFrom,
  DEFAULT_TIMEZONE,
  TIMEZONE_OPTIONS,
  timezoneLabel,
  zoneNote,
} from './timezones';

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

  it('brazilZoneFrom (ADR 51) leva cada fuso do Brasil ao da conta com o mesmo relógio', () => {
    expect(brazilZoneFrom('America/Manaus')).toBe('America/Manaus');
    expect(brazilZoneFrom('America/Recife')).toBe('America/Sao_Paulo');
    expect(brazilZoneFrom('America/Belem')).toBe('America/Sao_Paulo');
    expect(brazilZoneFrom('America/Campo_Grande')).toBe('America/Cuiaba');
    expect(brazilZoneFrom('America/Porto_Velho')).toBe('America/Manaus');
    expect(brazilZoneFrom('America/Eirunepe')).toBe('America/Rio_Branco');
    expect(brazilZoneFrom('Brazil/DeNoronha')).toBe('America/Noronha');
    // Todo fuso da lista da conta mapeia para ele mesmo.
    for (const o of TIMEZONE_OPTIONS) expect(brazilZoneFrom(o.value)).toBe(o.value);
    // Fora do Brasil, ou sem informação, não há o que sugerir.
    expect(brazilZoneFrom('America/Argentina/Buenos_Aires')).toBeNull();
    expect(brazilZoneFrom('Europe/Lisbon')).toBeNull();
    expect(brazilZoneFrom('UTC')).toBeNull();
    expect(brazilZoneFrom('')).toBeNull();
    expect(brazilZoneFrom(undefined)).toBeNull();
  });

  it('zoneNote (ADR 48) só aparece quando o fuso do outro não é o de quem vê', () => {
    expect(zoneNote('America/Rio_Branco', 'America/Sao_Paulo')).toBe(' (horário de Rio Branco)');
    // Quem vê sem fuso escolhido (ou sem conta) está em Brasília.
    expect(zoneNote('America/Rio_Branco', null)).toBe(' (horário de Rio Branco)');
    expect(zoneNote('America/Manaus', 'America/Manaus')).toBe('');
    expect(zoneNote('America/Sao_Paulo', undefined)).toBe('');
    expect(zoneNote(null, 'America/Manaus')).toBe('');
  });
});
