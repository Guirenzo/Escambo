import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  bucketsIn,
  defaultRange,
  monthEnd,
  monthStart,
  resolvePeriod,
  weekStart,
} from './report-period';

/** Períodos dos relatórios do admin: dias, semanas (segunda a domingo) e meses de Brasília. */
describe('report-period', () => {
  it('a semana começa na segunda: domingo volta seis dias, segunda fica', () => {
    expect(weekStart('2025-08-31')).toBe('2025-08-25'); // domingo
    expect(weekStart('2025-09-01')).toBe('2025-09-01'); // segunda
    expect(weekStart('2025-09-03')).toBe('2025-09-01'); // quarta
    // Atravessa a virada do ano: 01/01/2026 é quinta.
    expect(weekStart('2026-01-01')).toBe('2025-12-29');
  });

  it('início e fim do mês, com fevereiro e ano bissexto', () => {
    expect(monthStart('2026-02-14')).toBe('2026-02-01');
    expect(monthEnd('2026-02-14')).toBe('2026-02-28');
    expect(monthEnd('2028-02-01')).toBe('2028-02-29');
    expect(monthEnd('2026-12-31')).toBe('2026-12-31');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('padrão semanal: 12 semanas contando a atual, da segunda até hoje em Brasília', () => {
    // 01/09/2025 00:30 em Brasília (03:30 UTC) é segunda; 00:30 UTC ainda é domingo em Brasília.
    expect(defaultRange('week', new Date('2025-09-01T03:30:00Z'))).toEqual({
      from: '2025-06-16',
      to: '2025-09-01',
    });
    expect(defaultRange('week', new Date('2025-09-01T00:30:00Z'))).toEqual({
      from: '2025-06-09',
      to: '2025-08-31',
    });
  });

  it('resolvePeriod: período pedido vira instantes UTC; inválido ou longo demais é 400', () => {
    expect(resolvePeriod({ from: '2025-08-25', to: '2025-08-31', granularity: 'week' })).toEqual({
      from: '2025-08-25',
      to: '2025-08-31',
      fromUtc: new Date('2025-08-25T03:00:00Z'),
      toUtc: new Date('2025-09-01T03:00:00Z'),
    });
    expect(() =>
      resolvePeriod({ from: '2025-09-02', to: '2025-09-01', granularity: 'day' }),
    ).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_range' }));
    expect(() =>
      resolvePeriod({ from: '2024-01-01', to: '2025-09-01', granularity: 'month' }),
    ).toThrow(expect.objectContaining({ statusCode: 400, code: 'range_too_long' }));
  });

  describe('bucketsIn', () => {
    it('por dia: um balde por dia, todos inteiros', () => {
      expect(bucketsIn('2025-08-30', '2025-09-01', 'day')).toEqual([
        { key: '2025-08-30', start: '2025-08-30', end: '2025-08-30', whole: true },
        { key: '2025-08-31', start: '2025-08-31', end: '2025-08-31', whole: true },
        { key: '2025-09-01', start: '2025-09-01', end: '2025-09-01', whole: true },
      ]);
    });

    it('por semana: as pontas cortadas pelo período não são inteiras', () => {
      // 27/08 (quarta) a 08/09 (segunda): três semanas, só a do meio inteira.
      expect(bucketsIn('2025-08-27', '2025-09-08', 'week')).toEqual([
        { key: '2025-08-25', start: '2025-08-25', end: '2025-08-31', whole: false },
        { key: '2025-09-01', start: '2025-09-01', end: '2025-09-07', whole: true },
        { key: '2025-09-08', start: '2025-09-08', end: '2025-09-14', whole: false },
      ]);
    });

    it('por mês: chave AAAA-MM, do primeiro ao último dia do mês', () => {
      expect(bucketsIn('2025-08-01', '2025-09-15', 'month')).toEqual([
        { key: '2025-08', start: '2025-08-01', end: '2025-08-31', whole: true },
        { key: '2025-09', start: '2025-09-01', end: '2025-09-30', whole: false },
      ]);
    });
  });
});
