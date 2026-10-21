import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Category } from '@escambo/types';
import { categoryArt } from '../services/categoryArt';
import { categoryPhoto } from './photos';

/**
 * Categorias reais (GET /api/categories) em blocos com foto. O nome fica numa faixa de cor sólida
 * (o contraste não depende da foto) e o bloco inteiro é o link da categoria; as subcategorias vêm
 * em atalhos logo abaixo. Tudo leva à busca do app já filtrada (sem sessão, o app pede o login e
 * volta para ela).
 */
export function CategoryGrid({ categories, barter }: { categories: Category[]; barter: boolean }) {
  const children = categories.flatMap((root) => root.children ?? []);
  return (
    <section className="lp-band lp-cats-band" id="categorias" aria-labelledby="lp-cats-title">
      <div className="lp-wrap">
        <div className="lp-head">
          <p className="lp-kicker">Categorias</p>
          <h2 id="lp-cats-title">
            {barter ? 'O que dá para contratar (ou trocar)' : 'O que dá para contratar'}
          </h2>
          <p className="lp-sub">
            Escolha uma categoria para ver os serviços. Para contratar, você entra ou cria a sua
            conta.
          </p>
        </div>
        <ul className="lp-cats">
          {categories.map((root) => {
            const photo = categoryPhoto(root.slug);
            const { Icon, tone } = categoryArt(root.slug);
            return (
              <li key={root.id} className={`lp-cat${photo ? '' : ` lp-cat-art cover-${tone}`}`}>
                {photo ? (
                  <img
                    className="lp-cat-photo"
                    src={photo.src}
                    srcSet={photo.srcSet}
                    sizes="(min-width: 64rem) 22rem, (min-width: 40rem) 45vw, 100vw"
                    width={photo.width}
                    height={photo.height}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <span className="lp-cat-icon" aria-hidden="true">
                    <Icon size={40} strokeWidth={1.75} />
                  </span>
                )}
                <h3 className="lp-cat-band">
                  <Link to={`/servicos?categoria=${root.id}`} className="lp-cat-link">
                    {root.name}
                    <ArrowUpRight size={20} aria-hidden="true" className="lp-cat-arrow" />
                  </Link>
                </h3>
              </li>
            );
          })}
        </ul>
        {children.length > 0 && (
          <div className="lp-subcats">
            <p className="lp-subcats-label" id="lp-subcats-label">
              Subcategorias
            </p>
            <ul className="lp-chips" aria-labelledby="lp-subcats-label">
              {children.map((c) => (
                <li key={c.id}>
                  <Link to={`/servicos?categoria=${c.id}`} className="lp-chip">
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
