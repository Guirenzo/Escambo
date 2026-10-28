import { describe, expect, it } from 'vitest';
import {
  ageOn,
  formatCnpj,
  isValidCnpj,
  isValidCpf,
  maskCpf,
  normalizeCnpj,
  normalizeCpf,
  parseIsoDay,
} from './documents';

/** CPF e CNPJ (RF-018, RF-020): formato e dígitos verificadores, nunca consulta à Receita. */
describe('CPF', () => {
  it.each([
    ['529.982.247-25', '52998224725'],
    ['52998224725', '52998224725'],
    [' 111.444.777-35 ', '11144477735'],
  ])('normaliza %s', (input, digits) => {
    expect(normalizeCpf(input)).toBe(digits);
  });

  it.each(['5299822472', '529982247250', '529.982.247-2A', 'abc', ''])(
    'formato que não fecha: %s',
    (input) => {
      expect(normalizeCpf(input)).toBeNull();
    },
  );

  it.each(['52998224725', '11144477735', '39053344705'])('dígitos certos: %s', (cpf) => {
    expect(isValidCpf(cpf)).toBe(true);
  });

  it.each([
    ['52998224724', 'segundo dígito errado'],
    ['52998224715', 'primeiro dígito errado'],
    ['11111111111', 'todos iguais (os dígitos até fechariam)'],
    ['00000000000', 'todos zero'],
    ['5299822472', 'curto'],
    ['5299822472a', 'com letra'],
  ])('recusa %s (%s)', (cpf) => {
    expect(isValidCpf(cpf)).toBe(false);
  });

  it('o dígito 10 vira 0', () => {
    // 123.456.789-09: o primeiro verificador dá resto 10.
    expect(isValidCpf('12345678909')).toBe(true);
  });

  it('a máscara mostra só os 6 do meio', () => {
    expect(maskCpf('52998224725')).toBe('***.982.247-**');
  });
});

describe('CNPJ (numérico e alfanumérico, IN RFB 2.229/2024)', () => {
  it.each([
    ['11.222.333/0001-81', '11222333000181'],
    ['11222333000181', '11222333000181'],
    ['12.abc.345/01de-35', '12ABC34501DE35'],
    [' 12ABC34501DE35 ', '12ABC34501DE35'],
  ])('normaliza %s', (input, value) => {
    expect(normalizeCnpj(input)).toBe(value);
  });

  it.each(['1122233300018', '12ABC34501DEA5', '12ABC34501DE3X', '12_ABC34501DE35', ''])(
    'formato que não fecha: %s',
    (input) => {
      expect(normalizeCnpj(input)).toBeNull();
    },
  );

  it.each([
    ['11222333000181', 'numérico'],
    ['12ABC34501DE35', 'o exemplo alfanumérico da Receita'],
    ['00000000000191', 'numérico com zeros à esquerda'],
  ])('dígitos certos: %s (%s)', (cnpj) => {
    expect(isValidCnpj(cnpj)).toBe(true);
  });

  it.each([
    ['11222333000182', 'segundo dígito errado'],
    ['12ABC34501DE36', 'alfanumérico com o segundo dígito errado'],
    ['12ABC34501DF35', 'letra trocada'],
    ['00000000000000', 'todos iguais (os dígitos fechariam)'],
    ['AAAAAAAAAAAA00', 'base com tudo igual'],
    ['12abc34501de35', 'minúsculas (o normalizado é em maiúsculas)'],
    ['12ABC34501DE3', 'curto'],
  ])('recusa %s (%s)', (cnpj) => {
    expect(isValidCnpj(cnpj)).toBe(false);
  });

  it('a máscara de sempre, com letras', () => {
    expect(formatCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('data de nascimento e idade (RN-009)', () => {
  it('só datas que existem no calendário', () => {
    expect(parseIsoDay('2000-02-29')).toEqual({ y: 2000, m: 2, d: 29 });
    expect(parseIsoDay('2001-02-29')).toBeNull();
    expect(parseIsoDay('2001-13-01')).toBeNull();
    expect(parseIsoDay('2001-1-01')).toBeNull();
    expect(parseIsoDay('01/02/2001')).toBeNull();
  });

  it('o aniversário conta no próprio dia', () => {
    expect(ageOn('2008-10-26', '2026-10-25')).toBe(17);
    expect(ageOn('2008-10-26', '2026-10-26')).toBe(18);
    expect(ageOn('2008-03-15', '2026-10-26')).toBe(18);
    expect(ageOn('2008-12-01', '2026-10-26')).toBe(17);
  });

  it('quem nasceu em 29/02 faz anos em 01/03 nos anos comuns', () => {
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageOn('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('data inválida não tem idade', () => {
    expect(ageOn('2008-02-30', '2026-10-26')).toBeNull();
    expect(ageOn('2008-02-01', 'hoje')).toBeNull();
  });
});
