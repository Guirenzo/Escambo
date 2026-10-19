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

  it.each(['counter_offer_response_hours', 'extension_response_hours'])(
    '%s preserva inteiros de 24 a 168 h e usa o padrão oficial para dado inválido',
    (key) => {
      for (const raw of [
        null,
        undefined,
        '',
        '   ',
        'abc',
        'Infinity',
        '0',
        '-1',
        '23',
        '169',
        '48.5',
      ]) {
        // Nem um chamador com outro fallback pode expor um prazo inválido para estas chaves.
        expect(parseNumberSetting(raw, 96, key)).toBe(48);
      }
      expect(parseNumberSetting('24', 48, key)).toBe(24);
      expect(parseNumberSetting('168', 48, key)).toBe(168);
      expect(parseNumberSetting(' 72 ', 48, key)).toBe(72);
    },
  );

  it.each([
    ['withdrawal_pix_business_days', 1],
    ['withdrawal_bank_business_days', 2],
  ] as const)(
    '%s (RN-035) preserva inteiros de 1 a 10 dias úteis e usa o padrão (%i) para dado inválido',
    (key, standard) => {
      for (const raw of [null, undefined, '', '  ', 'abc', 'Infinity', '0', '-1', '11', '1.5']) {
        // Prazo zero, negativo ou quebrado travaria o pedido de saque (RangeError no cálculo).
        expect(parseNumberSetting(raw, 7, key)).toBe(standard);
      }
      expect(parseNumberSetting('1', 5, key)).toBe(1);
      expect(parseNumberSetting('10', 5, key)).toBe(10);
      expect(parseNumberSetting(' 3 ', 5, key)).toBe(3);
    },
  );

  it('a leitura de outras chaves conserva zero, decimal e valores fora de faixas antigas', () => {
    expect(parseNumberSetting('0', 7, 'strike_upload_block_days')).toBe(0);
    expect(parseNumberSetting('12.5', 10, 'min_service_price')).toBe(12.5);
    expect(parseNumberSetting('900', 24, 'deadline_grace_hours')).toBe(900);
  });
});
