import { LayoutGrid } from 'lucide-react';
import type { Category } from '@escambo/types';
import { Link } from 'react-router-dom';
import { useCategories } from '../../lib/hooks';
import { categoryArt, categoryPhoto } from './categoryArt';

/** A foto da categoria (decorativa) ou, sem foto, o ícone dela no tom da categoria. */
function CategoryImage({ category, sizes }: { category: Category; sizes: string }) {
  const photo = categoryPhoto(category.slug);
  const { Icon, tone } = categoryArt(category.slug);
  return (
    <span className={`cat-photo cover-${tone}`} aria-hidden="true">
      {photo ? (
        <img src={photo.src} srcSet={photo.srcSet} sizes={sizes} alt="" loading="lazy" />
      ) : (
        <Icon size={22} />
      )}
    </span>
  );
}

/**
 * As categorias raiz do catálogo com a foto de cada uma. Em `tiles` (Início) cada categoria é um
 * link para a busca filtrada por ela; em `chips` (Serviços) é um botão que liga o filtro
 * (aria-pressed), com "Todas" na frente. O nome fica num rótulo de cor sólida, nunca escrito sobre
 * a foto. Sem a árvore de categorias (carregando ou vazia), não mostra nada.
 */
export function CategoryStrip({
  variant,
  selected = 0,
  onSelect,
}: {
  variant: 'tiles' | 'chips';
  /** Em `chips`: a categoria do filtro (0 = todas). */
  selected?: number;
  onSelect?: (id: number) => void;
}) {
  const roots = useCategories().data ?? [];
  if (roots.length === 0) return null;

  if (variant === 'tiles') {
    return (
      <ul className="cat-tiles" aria-label="Categorias">
        {roots.map((c) => (
          <li key={c.id}>
            <Link to={`/servicos?categoria=${c.id}`} className="cat-tile">
              <CategoryImage category={c} sizes="(max-width: 720px) 45vw, 12rem" />
              <span className="cat-name">{c.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="cat-chips" aria-label="Categorias">
      <li>
        <button
          type="button"
          className="cat-chip"
          aria-pressed={selected === 0}
          onClick={() => onSelect?.(0)}
        >
          <span className="cat-photo cat-all" aria-hidden="true">
            <LayoutGrid size={18} />
          </span>
          Todas
        </button>
      </li>
      {roots.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className="cat-chip"
            aria-pressed={selected === c.id}
            onClick={() => onSelect?.(c.id)}
          >
            <CategoryImage category={c} sizes="48px" />
            {c.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
