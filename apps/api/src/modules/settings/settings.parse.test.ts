import { describe, expect, it } from 'vitest';
import { parseNumberSetting } from './settings.parse';

describe('parseNumberSetting (número de uma chave de platform_settings)', () => {
  it('chave ausente, em branco ou que não é número cai no padrão', () => {
    expect(parseNumberSetting(null, 24)).toBe(24);
    expect(parseNumberSetting(undefined, 24)).toBe(24);
    // Number('') e Number('  ') dariam 0: prazo zero em vez do padrão.
    expect(parseNumberSetting('', 24)).toBe(24);
    expect(parseNumberSetting('   ', 24)).toBe(24);
    expect(parseNumberSetting('\n\t', 24)).toBe(24);
    expect(parseNumberSetting('abc', 24)).toBe(24);
    expect(parseNumberSetting('Infinity', 24)).toBe(24);
  });

  it('número gravado vale, com espaços em volta, decimal e zero de verdade', () => {
    expect(parseNumberSetting('48', 24)).toBe(48);
    expect(parseNumberSetting(' 48 ', 24)).toBe(48);
    expect(parseNumberSetting('12.50', 10)).toBe(12.5);
    expect(parseNumberSetting('0', 15)).toBe(0);
  });
});
