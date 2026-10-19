import { describe, expect, it } from 'vitest';
import { BUSINESS_DAYS_ZONE, addBusinessDays, businessDueAt } from './business-days';

const iso = (d: Date): string => d.toISOString();

/**
 * Prazo do saque em dias úteis (RN-035), com o calendário de Brasília. Outubro de 2026: dia 9 é
 * sexta, 10 e 11 são fim de semana, 12 é segunda. A mesma tabela vale para o web
 * (lib/business-days.test.ts): o formulário prevê o dia que a API grava.
 */
describe('addBusinessDays (calendário puro)', () => {
  it('conta a partir do dia seguinte e pula sábado e domingo', () => {
    expect(addBusinessDays('2026-10-05', 1)).toBe('2026-10-06'); // seg → ter
    expect(addBusinessDays('2026-10-05', 2)).toBe('2026-10-07'); // seg → qua
    expect(addBusinessDays('2026-10-08', 2)).toBe('2026-10-12'); // qui → seg (pula o fim de semana)
    expect(addBusinessDays('2026-10-09', 1)).toBe('2026-10-12'); // sex → seg
    expect(addBusinessDays('2026-10-09', 2)).toBe('2026-10-13'); // sex → ter
  });

  it('pedido no fim de semana: o 1º dia útil é a segunda, como se fosse da sexta', () => {
    expect(addBusinessDays('2026-10-10', 1)).toBe('2026-10-12'); // sáb → seg
    expect(addBusinessDays('2026-10-11', 1)).toBe('2026-10-12'); // dom → seg
    expect(addBusinessDays('2026-10-11', 2)).toBe('2026-10-13'); // dom → ter
  });

  it('vira o mês e o ano; feriado não é descontado (1º de janeiro conta como dia útil)', () => {
    expect(addBusinessDays('2026-10-30', 1)).toBe('2026-11-02'); // sex → seg (novembro)
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01'); // qui → sex, feriado
    expect(addBusinessDays('2026-12-31', 2)).toBe('2027-01-04'); // qui → seg
  });

  it('dez dias úteis são duas semanas; zero é o próprio dia', () => {
    expect(addBusinessDays('2026-10-09', 10)).toBe('2026-10-23');
    expect(addBusinessDays('2026-10-09', 0)).toBe('2026-10-09');
    expect(addBusinessDays('2026-10-10', 0)).toBe('2026-10-10');
  });

  it.each([-1, 1.5, Number.NaN])('recusa %s dias úteis (RangeError)', (n) => {
    expect(() => addBusinessDays('2026-10-05', n)).toThrow(RangeError);
  });
});

describe('businessDueAt (instante gravado no saque)', () => {
  it('o calendário é o de Brasília', () => {
    expect(BUSINESS_DAYS_ZONE).toBe('America/Sao_Paulo');
  });

  it('vence às 23:59:59 de Brasília do n-ésimo dia útil depois do pedido', () => {
    const mondayNoon = new Date('2026-10-05T15:00:00Z'); // seg 12:00 em Brasília
    expect(iso(businessDueAt(mondayNoon, 1))).toBe('2026-10-07T02:59:59.000Z'); // ter 23:59:59
    expect(iso(businessDueAt(mondayNoon, 2))).toBe('2026-10-08T02:59:59.000Z'); // qua 23:59:59
  });

  it('sexta à noite em Brasília (já sábado em UTC) ainda é sexta: PIX na segunda, TED na terça', () => {
    const fridayNight = new Date('2026-10-10T01:30:00Z'); // sex 22:30 em Brasília
    expect(iso(businessDueAt(fridayNight, 1))).toBe('2026-10-13T02:59:59.000Z');
    expect(iso(businessDueAt(fridayNight, 2))).toBe('2026-10-14T02:59:59.000Z');
    // O último segundo da sexta e o primeiro do sábado dão o mesmo prazo.
    expect(iso(businessDueAt(new Date('2026-10-10T02:59:59Z'), 1))).toBe(
      '2026-10-13T02:59:59.000Z',
    );
    expect(iso(businessDueAt(new Date('2026-10-10T03:00:00Z'), 1))).toBe(
      '2026-10-13T02:59:59.000Z',
    );
  });

  it('o fuso decide o dia: quinta 21:30 em Brasília (sexta em UTC) vence na sexta, e não na segunda', () => {
    expect(iso(businessDueAt(new Date('2026-10-09T00:30:00Z'), 1))).toBe(
      '2026-10-10T02:59:59.000Z',
    );
    // Domingo 22:00 em Brasília (segunda em UTC): o 1º dia útil é a própria segunda.
    expect(iso(businessDueAt(new Date('2026-10-12T01:00:00Z'), 1))).toBe(
      '2026-10-13T02:59:59.000Z',
    );
  });

  it('quem pede em Manaus segue o calendário de Brasília: quinta 23:30 lá já é sexta aqui', () => {
    // 2026-10-09T03:30Z = qui 23:30 em Manaus = sex 00:30 em Brasília → 1 dia útil = segunda.
    expect(iso(businessDueAt(new Date('2026-10-09T03:30:00Z'), 1))).toBe(
      '2026-10-13T02:59:59.000Z',
    );
  });

  it('virada do ano: 31/12 (qui) por TED vence na segunda, 04/01', () => {
    expect(iso(businessDueAt(new Date('2026-12-31T15:00:00Z'), 2))).toBe(
      '2027-01-05T02:59:59.000Z',
    );
  });
});
