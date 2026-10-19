import { describe, expect, it } from 'vitest';
import {
  BUSINESS_DAYS_ZONE,
  DEFAULT_WITHDRAWAL_BUSINESS_DAYS,
  addBusinessDays,
  businessDaysLabel,
  dueDayText,
  withdrawalDueAt,
} from './business-days';

/**
 * Espelho do cálculo da API (utils/business-days.test.ts), com os mesmos vetores: outubro de 2026,
 * dia 9 é sexta, 10 e 11 são fim de semana, 12 é segunda.
 */
describe('addBusinessDays', () => {
  it('conta a partir do dia seguinte e pula sábado e domingo', () => {
    expect(addBusinessDays('2026-10-05', 1)).toBe('2026-10-06');
    expect(addBusinessDays('2026-10-05', 2)).toBe('2026-10-07');
    expect(addBusinessDays('2026-10-08', 2)).toBe('2026-10-12');
    expect(addBusinessDays('2026-10-09', 1)).toBe('2026-10-12');
    expect(addBusinessDays('2026-10-09', 2)).toBe('2026-10-13');
  });

  it('do fim de semana, o 1º dia útil é a segunda; vira mês e ano; feriado conta', () => {
    expect(addBusinessDays('2026-10-10', 1)).toBe('2026-10-12');
    expect(addBusinessDays('2026-10-11', 2)).toBe('2026-10-13');
    expect(addBusinessDays('2026-10-30', 1)).toBe('2026-11-02');
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addBusinessDays('2026-12-31', 2)).toBe('2027-01-04');
    expect(addBusinessDays('2026-10-09', 10)).toBe('2026-10-23');
  });
});

describe('withdrawalDueAt (o que a API vai gravar)', () => {
  it('23:59:59 de Brasília do n-ésimo dia útil', () => {
    expect(BUSINESS_DAYS_ZONE).toBe('America/Sao_Paulo');
    const mondayNoon = new Date('2026-10-05T15:00:00Z');
    expect(withdrawalDueAt(1, mondayNoon)).toBe('2026-10-07T02:59:59.000Z');
    expect(withdrawalDueAt(2, mondayNoon)).toBe('2026-10-08T02:59:59.000Z');
  });

  it('sexta à noite em Brasília (sábado em UTC) ainda é sexta; quinta 21:30 (sexta em UTC) vence na sexta', () => {
    expect(withdrawalDueAt(1, new Date('2026-10-10T01:30:00Z'))).toBe('2026-10-13T02:59:59.000Z');
    expect(withdrawalDueAt(2, new Date('2026-10-10T01:30:00Z'))).toBe('2026-10-14T02:59:59.000Z');
    expect(withdrawalDueAt(1, new Date('2026-10-09T00:30:00Z'))).toBe('2026-10-10T02:59:59.000Z');
    expect(withdrawalDueAt(1, new Date('2026-10-12T01:00:00Z'))).toBe('2026-10-13T02:59:59.000Z');
  });

  it('sem instante, usa o relógio do navegador', () => {
    expect(withdrawalDueAt(1)).toMatch(/T02:59:59\.000Z$/);
  });
});

describe('textos do prazo', () => {
  it('o dia é o de Brasília, com o dia da semana', () => {
    expect(dueDayText('2026-10-13T02:59:59.000Z')).toBe('seg, 12/10');
    expect(dueDayText('2027-01-02T02:59:59.000Z')).toBe('sex, 01/01');
  });

  it('singular e plural; os padrões são os da RN-035', () => {
    expect(businessDaysLabel(1)).toBe('1 dia útil');
    expect(businessDaysLabel(2)).toBe('2 dias úteis');
    expect(DEFAULT_WITHDRAWAL_BUSINESS_DAYS).toEqual({ pix: 1, bank: 2 });
  });
});
