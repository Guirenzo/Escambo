import { describe, expect, it } from 'vitest';
import { BRAZIL_AREA_CODES, normalizeBrazilPhone } from './phone';
import { updatePhoneSchema } from './auth.schema';

/**
 * Telefone da conta (RF-017): o que as pessoas digitam vira E.164 do Brasil; o que não for um
 * número brasileiro com DDD válido é recusado, em vez de guardado pela metade.
 */
describe('normalizeBrazilPhone', () => {
  it.each([
    ['(47) 99999-1234', '+5547999991234'],
    ['47 99999 1234', '+5547999991234'],
    ['47999991234', '+5547999991234'],
    ['+55 (47) 99999-1234', '+5547999991234'],
    ['+5547999991234', '+5547999991234'],
    ['5547999991234', '+5547999991234'],
    ['047 99999-1234', '+5547999991234'],
    ['  11 98765.4321  ', '+5511987654321'],
    ['(47) 3433-1234', '+554734331234'],
    ['+55 21 2555-0000', '+552125550000'],
    ['554734331234', '+554734331234'],
    ['04734331234', '+554734331234'],
    // DDD 55 (RS) sem o código do país: 11 dígitos é número nacional, não "55" + 9 dígitos.
    ['55 99123-4567', '+5555991234567'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBrazilPhone(input)).toBe(expected);
  });

  it.each([
    ['', 'vazio'],
    ['abc', 'sem dígitos'],
    ['47 9999-12a4', 'letra no meio'],
    ['+1 415 555 0100', 'outro país com +'],
    ['+54 11 1234 5678', 'código de país que não é o 55'],
    ['9999-1234', 'sem DDD'],
    ['47 99999-12345', 'dígito a mais'],
    ['10 99999-1234', 'DDD que não existe (10)'],
    ['20 3333-1234', 'DDD que não existe (20)'],
    ['00 99999-1234', 'DDD 00'],
    ['47 89999-1234', 'celular de 9 dígitos que não começa com 9'],
    ['47 9999-1234', 'fixo que começa com 9 (celular antigo, sem o nono dígito)'],
    ['47 1999-1234', 'fixo que começa com 1'],
    ['47 6999-1234', 'fixo que começa com 6'],
    ['+55 47 99999 1234 0', 'E.164 com dígito a mais'],
    ['++5547999991234', 'dois sinais de +'],
    ['4799999+1234', '+ no meio'],
  ])('%s é recusado (%s)', (input) => {
    expect(normalizeBrazilPhone(input)).toBeNull();
  });

  it('a lista de DDDs tem os 67 códigos em uso e nenhum terminado em 0', () => {
    expect(BRAZIL_AREA_CODES.size).toBe(67);
    for (const code of BRAZIL_AREA_CODES) expect(code).toMatch(/^[1-9][1-9]$/);
  });
});

describe('updatePhoneSchema', () => {
  it('normaliza para E.164; null e texto em branco apagam o telefone', () => {
    expect(updatePhoneSchema.parse({ phone: '(47) 99999-1234' })).toEqual({
      phone: '+5547999991234',
    });
    expect(updatePhoneSchema.parse({ phone: null })).toEqual({ phone: null });
    expect(updatePhoneSchema.parse({ phone: '   ' })).toEqual({ phone: null });
  });

  it('recusa número inválido, texto longo demais e a falta do campo, com a mensagem para a tela', () => {
    for (const phone of ['123', 'x'.repeat(31)]) {
      const out = updatePhoneSchema.safeParse({ phone });
      expect(out.success).toBe(false);
      expect(out.error!.flatten().fieldErrors.phone).toEqual([
        'Telefone inválido: use um número do Brasil com DDD, como (47) 99999-1234',
      ]);
    }
    expect(updatePhoneSchema.safeParse({}).success).toBe(false);
  });
});
