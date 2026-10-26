import {
  Briefcase,
  Code,
  GraduationCap,
  Hammer,
  Megaphone,
  Palette,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { Category } from '@escambo/types';
import { useMemo } from 'react';
import { useCategories } from '../../lib/hooks';

/** O desenho da categoria na capa do card sem imagem: um ícone e um tom (classe `cover-<tom>`). */
export interface CategoryArt {
  Icon: LucideIcon;
  tone: 'blue' | 'violet' | 'amber' | 'green' | 'teal' | 'rose' | 'neutral';
  /**
   * As fotos da categoria (pessoas fictícias geradas para o Escambo, em public/img/pessoas): ilustram
   * a categoria e nunca aparecem com nome, nota ou depoimento, como se fossem alguém da plataforma.
   * A primeira é a da categoria; as outras alternam nos cards, para a grade não repetir a mesma.
   */
  photos?: string[];
}

/** Pelas categorias raiz do seed de referência; uma categoria nova cai no neutro (sem foto). */
const BY_SLUG: Record<string, CategoryArt> = {
  tecnologia: { Icon: Code, tone: 'blue', photos: ['dev', 'dupla-troca'] },
  design: { Icon: Palette, tone: 'violet', photos: ['designer', 'fotografa'] },
  'reformas-reparos': { Icon: Hammer, tone: 'amber', photos: ['eletricista'] },
  'aulas-cursos': { Icon: GraduationCap, tone: 'green', photos: ['professora'] },
  'servicos-domesticos': { Icon: Sparkles, tone: 'teal', photos: ['jardineira'] },
  marketing: { Icon: Megaphone, tone: 'rose', photos: ['social-media', 'fotografa'] },
};

const NEUTRAL: CategoryArt = { Icon: Briefcase, tone: 'neutral' };

export const categoryArt = (slug?: string | null): CategoryArt =>
  (slug && BY_SLUG[slug]) || NEUTRAL;

/** Os dois tamanhos da foto (400 e 800 px de largura, retrato 4:5), para o `srcSet` da imagem. */
export interface CategoryPhoto {
  src: string;
  srcSet: string;
}

/**
 * A foto da categoria raiz, ou null quando ela não tem (categoria nova ou nenhuma). Com `seed` (o id
 * do serviço), escolhe entre as fotos da categoria por um espalhamento do id (ids vizinhos, mesmo
 * todos pares, não caem sempre na mesma foto); sem ele, é a primeira.
 */
export function categoryPhoto(slug?: string | null, seed?: number): CategoryPhoto | null {
  const photos = categoryArt(slug).photos ?? [];
  if (photos.length === 0) return null;
  const index =
    seed === undefined ? 0 : (Math.imul(Math.trunc(seed) + 1, 0x9e3779b1) >>> 16) % photos.length;
  const photo = photos[index]!;
  const base = `/img/pessoas/${photo}`;
  return { src: `${base}-400.webp`, srcSet: `${base}-400.webp 400w, ${base}.webp 800w` };
}

/** Cada categoria (raiz ou subcategoria) apontando para a raiz dela. */
export function rootsById(tree: Category[]): Map<number, Category> {
  const map = new Map<number, Category>();
  const walk = (node: Category, root: Category): void => {
    map.set(node.id, root);
    for (const child of node.children ?? []) walk(child, root);
  };
  for (const root of tree) walk(root, root);
  return map;
}

/** A categoria raiz de cada id, a partir da árvore em cache (vazio enquanto ela não chega). */
export function useCategoryRoots(): Map<number, Category> {
  const { data } = useCategories();
  return useMemo(() => rootsById(data ?? []), [data]);
}
