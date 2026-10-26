import { describe, expect, it } from 'vitest';
import { allBuckets, bucketFullLabel, bucketLabel } from './buckets';

/** Os baldes do período na mesma chave que a API agrupa (o gráfico precisa dos vazios). */
describe('allBuckets', () => {
  it('por mês, virando o ano', () => {
    expect(allBuckets('2025-11-15', '2026-02-03', 'month')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('por dia, de ponta a ponta', () => {
    expect(allBuckets('2026-08-30', '2026-09-02', 'day')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('por semana, começando na segunda da semana do início (domingo cai na semana anterior)', () => {
    expect(allBuckets('2026-09-13', '2026-09-24', 'week')).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ]);
    expect(allBuckets('2026-09-14', '2026-09-14', 'week')).toEqual(['2026-09-14']);
  });

  it('rótulos curto e completo', () => {
    expect(bucketLabel('2026-09')).toBe('09/2026');
    expect(bucketFullLabel('2026-09-07', 'week')).toBe('07/09 a 13/09');
  });
});
