import type { PublicSettings } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import { days, factsFrom, money, parseMoney, percent, tornaQuote, tradeExample } from './facts';

/** O Intl usa espaço inseparável depois do "R$": nos testes, vira espaço comum. */
const plain = (s: string): string => s.replace(/\s/g, ' ');

describe('factsFrom', () => {
  it('lê taxa, aprovação automática, saque mínimo e a troca dos parâmetros públicos', () => {
    const settings = {
      platformFeePercentage: 12.5,
      tacitApprovalDays: 7,
      minWithdrawalAmount: 50,
      barterEnabled: false,
    } as PublicSettings;
    expect(factsFrom(settings)).toEqual({
      fee: 12.5,
      tacitDays: 7,
      minWithdrawal: 50,
      barter: false,
    });
  });

  it('sem resposta da API, nenhum número (o texto cai na versão sem número) e a troca ligada', () => {
    expect(factsFrom(undefined)).toEqual({
      fee: null,
      tacitDays: null,
      minWithdrawal: null,
      barter: true,
    });
  });

  it('valor estranho (negativo, não numérico) vira "sem número", nunca aparece', () => {
    const settings = {
      platformFeePercentage: -1,
      tacitApprovalDays: Number.NaN,
      minWithdrawalAmount: '20',
    } as unknown as PublicSettings;
    expect(factsFrom(settings)).toMatchObject({ fee: null, tacitDays: null, minWithdrawal: null });
  });
});

describe('formatação', () => {
  it('porcentagem no jeito brasileiro', () => {
    expect(percent(15)).toBe('15%');
    expect(percent(12.5)).toBe('12,5%');
  });

  it('dinheiro sem centavos quando é inteiro, com centavos quando não é', () => {
    expect(plain(money(1200))).toBe('R$ 1.200');
    expect(plain(money(61.5))).toBe('R$ 61,50');
  });

  it('dia no singular e no plural', () => {
    expect(days(1)).toBe('1 dia');
    expect(days(5)).toBe('5 dias');
  });
});

describe('tradeExample (a conta da torna, como a API faz)', () => {
  it('com 15%: torna de R$ 400, taxa de R$ 60 e R$ 340 para quem recebe', () => {
    expect(tradeExample(15)).toEqual({ torna: 400, feeValue: 60, net: 340 });
  });

  it('a taxa vem do painel: outra taxa, outra conta, arredondada ao centavo', () => {
    expect(tradeExample(12.5)).toEqual({ torna: 400, feeValue: 50, net: 350 });
    expect(tradeExample(15.55)).toEqual({ torna: 400, feeValue: 62.2, net: 337.8 });
  });

  it('sem a taxa, só a torna', () => {
    expect(tradeExample(null)).toEqual({ torna: 400, feeValue: null, net: null });
  });
});

describe('parseMoney (o valor do jeito que a pessoa digita)', () => {
  it.each([
    ['1200', 1200],
    ['1.200', 1200],
    ['12.500.000', 12500000],
    ['1.200,50', 1200.5],
    ['99,9', 99.9],
    ['99.90', 99.9],
    ['R$ 800', 800],
    ['  350 ', 350],
    ['1.', 1],
    [',5', 0.5],
    ['10,333', 10.33],
  ])('%s vira %s', (raw, value) => {
    expect(parseMoney(raw)).toBe(value);
  });

  it.each(['', '   ', 'abc', '-50', '12a', '.', 'R$'])('%j não é valor', (raw) => {
    expect(parseMoney(raw)).toBeNull();
  });
});

describe('tornaQuote (a calculadora da torna, como a API faz)', () => {
  it('você quer o serviço mais caro: você completa, a taxa sai de quem recebe', () => {
    expect(tornaQuote(800, 1200, 15)).toEqual({ torna: 400, payer: 'you', feeValue: 60, net: 340 });
  });

  it('você oferece o mais caro: a outra pessoa completa e você recebe a torna menos a taxa', () => {
    expect(tornaQuote(1500, 900.5, 15)).toEqual({
      torna: 599.5,
      payer: 'other',
      feeValue: 89.93,
      net: 509.57,
    });
  });

  it('troca equilibrada: sem torna e sem taxa', () => {
    expect(tornaQuote(500, 500, 15)).toEqual({ torna: 0, payer: 'none', feeValue: 0, net: 0 });
  });

  it('sem a taxa (parâmetros ainda não chegaram), só a torna e quem paga', () => {
    expect(tornaQuote(100, 250, null)).toEqual({
      torna: 150,
      payer: 'you',
      feeValue: null,
      net: null,
    });
  });
});
