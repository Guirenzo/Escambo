import { describe, expect, it } from 'vitest';
import { orderClause } from './services.repository';

describe('orderClause (busca de serviços)', () => {
  it('relevância: destaque primeiro; depois recência ou proximidade', () => {
    expect(orderClause('relevance', false)).toBe('boosted DESC, s.created_at DESC, s.id DESC');
    expect(orderClause('relevance', true, 'sub')).toBe('sub.boosted DESC, sub.distance_km ASC');
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
    expect(orderClause('distance', true, 'sub')).toBe('sub.distance_km ASC, sub.boosted DESC');
    expect(orderClause('distance', false)).toBe('boosted DESC, s.created_at DESC, s.id DESC');
    expect(orderClause('newest', false)).toBe('s.created_at DESC, s.id DESC');
  });
});
