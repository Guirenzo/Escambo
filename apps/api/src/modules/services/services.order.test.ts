import { describe, expect, it } from 'vitest';
import { orderClause, sortKeys, type ServiceSort } from './services.repository';

const SORTS: ServiceSort[] = [
  'relevance',
  'price_asc',
  'price_desc',
  'rating',
  'newest',
  'distance',
];

describe('orderClause (busca de serviços)', () => {
  it('relevância: destaque primeiro; depois recência ou proximidade', () => {
    expect(orderClause('relevance', false)).toBe('boosted DESC, s.created_at DESC, s.id DESC');
    expect(orderClause('relevance', true, 'sub')).toBe(
      'sub.boosted DESC, sub.distance_km ASC, sub.id ASC',
    );
  });

  it('preço: sem preço vai para o fim; destaque não fura a fila', () => {
    expect(orderClause('price_asc', false)).toBe(
      's.price IS NULL, s.price ASC, s.created_at DESC, s.id DESC',
    );
    expect(orderClause('price_desc', true, 'sub')).toBe(
      'sub.price IS NULL, sub.price DESC, sub.created_at DESC, sub.id DESC',
    );
  });

  it('nota usa as colunas do prestador (com o alias certo na tabela derivada)', () => {
    expect(orderClause('rating', false)).toBe(
      'COALESCE(pf.avg_rating, 0) DESC, COALESCE(pf.total_reviews, 0) DESC, s.created_at DESC, s.id DESC',
    );
    expect(orderClause('rating', true, 'sub')).toBe(
      'COALESCE(sub.owner_avg_rating, 0) DESC, COALESCE(sub.owner_total_reviews, 0) DESC, sub.created_at DESC, sub.id DESC',
    );
  });

  it('distância só com geolocalização; sem ela cai na relevância', () => {
    expect(orderClause('distance', true, 'sub')).toBe(
      'sub.distance_km ASC, sub.boosted DESC, sub.id ASC',
    );
    expect(orderClause('distance', false)).toBe('boosted DESC, s.created_at DESC, s.id DESC');
    expect(orderClause('newest', false)).toBe('s.created_at DESC, s.id DESC');
  });

  it.each(SORTS.flatMap((sort) => [false, true].map((geo) => [sort, geo] as const)))(
    '%s (geo %s) termina no id: a ordem é total, e a página de ids e a consulta de fora concordam',
    (sort, geo) => {
      expect(orderClause(sort, geo, 'page')).toMatch(/, page\.id (ASC|DESC)$/);
    },
  );
});

describe('sortKeys (as colunas da página de ids)', () => {
  /** O nome com que cada chave chega à tabela derivada: o alias, ou a coluna sem a tabela. */
  const names = (sort: ServiceSort, geo: boolean): string[] =>
    sortKeys(sort, geo).map((key) => /(?: AS |\.)(\w+)$/.exec(key)![1]!);

  it.each(SORTS.flatMap((sort) => [false, true].map((geo) => [sort, geo] as const)))(
    '%s (geo %s): a página leva toda coluna que o ORDER BY de fora usa, e o id primeiro',
    (sort, geo) => {
      const used = [...orderClause(sort, geo, 'page').matchAll(/page\.(\w+)/g)].map((m) => m[1]!);
      // Na proximidade, a distância é calculada na página à parte das chaves.
      const carried = [...names(sort, geo), ...(geo ? ['distance_km'] : [])];
      for (const column of used) expect(carried).toContain(column);
      expect(sortKeys(sort, geo)[0]).toBe('s.id');
    },
  );

  it('só o que a ordem usa: o destaque só na relevância (e na distância), o preço só no preço', () => {
    expect(sortKeys('relevance', false)).toEqual([
      's.id',
      '(ab.service_id IS NOT NULL) AS boosted',
      's.created_at',
    ]);
    expect(sortKeys('relevance', true)).toEqual(['s.id', '(ab.service_id IS NOT NULL) AS boosted']);
    expect(sortKeys('distance', true)).toEqual(sortKeys('relevance', true));
    expect(sortKeys('price_asc', false)).toEqual(['s.id', 's.price', 's.created_at']);
    expect(sortKeys('newest', true)).toEqual(['s.id', 's.created_at']);
    expect(sortKeys('rating', false)).toEqual([
      's.id',
      'pf.avg_rating AS owner_avg_rating',
      'pf.total_reviews AS owner_total_reviews',
      's.created_at',
    ]);
  });
});
