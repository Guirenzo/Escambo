import { LayoutGrid } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCategories } from '../../lib/hooks';
import { CATEGORY_GROUNDS, categoryArt } from './categoryArt';

/**
 * As categorias raiz do catálogo, cada uma com o desenho do ofício sobre uma cor chapada (o mesmo
 * par nas duas formas, para a pessoa reconhecer a categoria de uma tela para a outra). Em `tiles`
 * (Início) cada categoria é uma figurinha e um link para a busca filtrada por ela; em `chips`
 * (Serviços) é um botão que liga o filtro (aria-pressed), com "Todas" na frente. O desenho é
 * decorativo; o nome é o texto. Sem a árvore de categorias (carregando ou vazia), não mostra nada.
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
        {roots.map((c, i) => {
          const { Icon } = categoryArt(c.slug);
          return (
            <li key={c.id}>
              <Link to={`/servicos?categoria=${c.id}`} className="cat-tile">
                <span
                  className={`cat-art al-g-${CATEGORY_GROUNDS[i % CATEGORY_GROUNDS.length]}`}
                  aria-hidden="true"
                >
                  <Icon strokeWidth={1.75} />
                </span>
                <span className="cat-name">{c.name}</span>
              </Link>
            </li>
          );
        })}
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
          <span className="cat-ico cat-all" aria-hidden="true">
            <LayoutGrid size={18} />
          </span>
          Todas
        </button>
      </li>
      {roots.map((c, i) => {
        const { Icon } = categoryArt(c.slug);
        return (
          <li key={c.id}>
            <button
              type="button"
              className="cat-chip"
              aria-pressed={selected === c.id}
              onClick={() => onSelect?.(c.id)}
            >
              <span
                className={`cat-ico al-g-${CATEGORY_GROUNDS[i % CATEGORY_GROUNDS.length]}`}
                aria-hidden="true"
              >
                <Icon size={18} strokeWidth={1.9} />
              </span>
              {c.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
