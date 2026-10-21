import type { Category } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import { categoryArt, categoryPhoto, rootsById } from './categoryArt';

const cat = (id: number, slug: string, children: Category[] = []): Category => ({
  id,
  parentId: null,
  name: slug,
  slug,
  iconUrl: null,
  children,
});

describe('categoryArt', () => {
  it('cada categoria raiz do seed tem o seu tom; a desconhecida (ou nenhuma) cai no neutro', () => {
    expect(
      [
        'tecnologia',
        'design',
        'reformas-reparos',
        'aulas-cursos',
        'servicos-domesticos',
        'marketing',
      ].map((s) => categoryArt(s).tone),
    ).toEqual(['blue', 'violet', 'amber', 'green', 'teal', 'rose']);
    expect(categoryArt('nova').tone).toBe('neutral');
    expect(categoryArt(undefined).tone).toBe('neutral');
    expect(categoryArt(null).tone).toBe('neutral');
  });

  it('cada categoria raiz do seed tem a sua foto (400 e 800 px); sem foto, null', () => {
    expect(categoryPhoto('reformas-reparos')).toEqual({
      src: '/img/pessoas/eletricista-400.webp',
      srcSet: '/img/pessoas/eletricista-400.webp 400w, /img/pessoas/eletricista.webp 800w',
    });
    expect(
      [
        'tecnologia',
        'design',
        'reformas-reparos',
        'aulas-cursos',
        'servicos-domesticos',
        'marketing',
      ].map((s) => categoryArt(s).photos?.[0]),
    ).toEqual(['dev', 'designer', 'eletricista', 'professora', 'jardineira', 'social-media']);
    // O id do serviço escolhe entre as fotos da categoria: ids vizinhos (mesmo só pares ou só
    // ímpares) se alternam, e a grade não repete a mesma foto em fila.
    const pick = (ids: number[]) =>
      ids.map((id) =>
        categoryPhoto('design', id)?.src.replace(/^\/img\/pessoas\/|-400\.webp$/g, ''),
      );
    expect(pick([2, 4, 6, 8])).toEqual(['designer', 'fotografa', 'designer', 'fotografa']);
    expect(pick([1, 3, 5, 7])).toEqual(['designer', 'fotografa', 'designer', 'fotografa']);
    expect(categoryPhoto('reformas-reparos', 7)?.src).toBe('/img/pessoas/eletricista-400.webp');
    // Sem o id, a primeira (a da faixa de categorias).
    expect(categoryPhoto('design')?.src).toBe('/img/pessoas/designer-400.webp');
    expect(categoryPhoto('nova')).toBeNull();
    expect(categoryPhoto(undefined)).toBeNull();
  });

  it('rootsById aponta raiz e subcategorias (em qualquer profundidade) para a raiz', () => {
    const neta = cat(31, 'logo');
    const tree = [cat(1, 'design', [cat(13, 'identidade-visual', [neta])]), cat(2, 'marketing')];
    const roots = rootsById(tree);
    expect([1, 13, 31, 2].map((id) => roots.get(id)?.slug)).toEqual([
      'design',
      'design',
      'design',
      'marketing',
    ]);
    expect(roots.get(99)).toBeUndefined();
    expect(rootsById([]).size).toBe(0);
  });
});
