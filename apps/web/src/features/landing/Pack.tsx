import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Category, Service } from '@escambo/types';
import { api } from '../../lib/api';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { categoryArt, categoryPhoto, rootsById } from '../services/categoryArt';
import { servicePrice } from '../services/ServiceCard';
import { HOLO, type StickerGround } from './album';
import { SHOWCASE_LIMIT } from './Showcase';

/** Quantas figurinhas vêm num pacotinho. */
export const PACK_SIZE = 5;

/**
 * A página do primeiro pacote: a seguinte às que a vitrine já mostra (os mais recentes), para as
 * figurinhas do pacote não repetirem as da vitrine logo abaixo.
 */
export const PACK_FIRST_PAGE = Math.floor(SHOWCASE_LIMIT / PACK_SIZE) + 2;

const GROUNDS: readonly StickerGround[] = ['sky', 'amber', 'lilac', 'lime', 'tomato'];

/** A brilhante do pacote: o serviço de quem tem a melhor nota; sem nota nenhuma, a primeira. */
export function foilIndex(items: readonly Pick<Service, 'ownerRating' | 'ownerReviews'>[]): number {
  let best = 0;
  let bestRating = -1;
  items.forEach((s, i) => {
    const rating = s.ownerReviews && s.ownerReviews > 0 ? Number(s.ownerRating ?? 0) : -1;
    if (rating > bestRating) {
      best = i;
      bestRating = rating;
    }
  });
  return best;
}

/** O pacotinho fechado: desenho vetorial (geometria), decorativo. A aba de cima é a que rasga. */
function PackArt() {
  const crimp = Array.from({ length: 23 }, (_, i) => 14 + i * 8);
  return (
    <svg className="pk-art" viewBox="0 0 200 270" aria-hidden="true" focusable="false">
      <g className="pk-art-body">
        <rect x="4" y="30" width="192" height="236" rx="10" className="pk-fill" />
        {crimp.map((x) => (
          <line key={`b${x}`} x1={x} y1="246" x2={x} y2="262" className="pk-crimp" />
        ))}
        <circle cx="100" cy="118" r="46" className="pk-badge" />
        <path
          className="pk-arrows"
          d="M78 108h40l-9-9M122 128H82l9 9"
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text x="100" y="196" textAnchor="middle" className="pk-word">
          ESCAMBO
        </text>
        <text x="100" y="222" textAnchor="middle" className="pk-count">
          {PACK_SIZE} figurinhas
        </text>
      </g>
      <g className="pk-art-top">
        <rect x="4" y="4" width="192" height="30" rx="8" className="pk-fill" />
        {crimp.map((x) => (
          <line key={`t${x}`} x1={x} y1="9" x2={x} y2="27" className="pk-crimp" />
        ))}
      </g>
    </svg>
  );
}

/**
 * O pacotinho: fechado até a pessoa abrir. Aberto, busca cinco serviços de verdade
 * (GET /api/services, pública) e os distribui nos quadros. Começa depois do que a vitrine mostra;
 * "abrir outro" traz a página seguinte e, acabando a lista, volta ao começo (num catálogo pequeno,
 * o pacote é o próprio começo). Sem movimento (prefers-reduced-motion), as figurinhas só
 * aparecem nos quadros.
 */
export function Pack({ categories }: { categories: Category[] }) {
  const titleId = useId();
  const [page, setPage] = useState(0);
  const roots = useMemo(() => rootsById(categories), [categories]);
  const list = useQuery({
    queryKey: ['landing', 'pack', page],
    queryFn: () => api.listServices({ limit: PACK_SIZE, page }),
    enabled: page > 0,
  });
  const items = page > 0 ? (list.data?.items ?? []) : [];
  const opened = page > 0 && list.isSuccess;
  const lastPack = opened && items.length < PACK_SIZE;
  // Catálogo que cabe num pacote só: não há outro para abrir.
  const onlyPack = lastPack && page === 1;
  // Passou do fim da lista (página vazia depois da primeira): volta ao primeiro pacote.
  useEffect(() => {
    if (opened && items.length === 0 && page > 1) setPage(1);
  }, [opened, items.length, page]);

  const foil = foilIndex(items);
  const status =
    page === 0
      ? ''
      : list.isError
        ? 'Não deu para abrir o pacotinho agora.'
        : !opened
          ? 'Abrindo o pacotinho…'
          : items.length === 0
            ? 'Ainda não há serviços publicados.'
            : `${items.length} ${items.length === 1 ? 'serviço' : 'serviços'} no pacotinho.`;

  return (
    <section className="pk" aria-labelledby={titleId}>
      <div className="lp-wrap pk-grid">
        {/* A chave troca a cada pacote: um pacote novo, fechado, que rasga de novo. */}
        <div className={`pk-pack${page > 0 ? ' is-open' : ''}`} key={`pack-${page}`}>
          <PackArt />
        </div>
        <div className="pk-copy">
          <h2 id={titleId}>Abra um pacotinho</h2>
          <p className="pk-sub">
            Cinco serviços publicados no Escambo, tirados da vitrine. Vai que sai o que falta para
            você.
          </p>
          <div className="pk-actions">
            {!onlyPack && (
              <button
                type="button"
                className="lp-btn lp-btn-amber lp-btn-lg"
                onClick={() => setPage((p) => (p === 0 ? PACK_FIRST_PAGE : lastPack ? 1 : p + 1))}
                disabled={page > 0 && list.isFetching}
              >
                {page === 0 ? 'Abrir pacotinho' : 'Abrir outro pacotinho'}
              </button>
            )}
            {list.isError && (
              <button
                type="button"
                className="lp-btn lp-btn-light lp-btn-lg"
                onClick={() => void list.refetch()}
              >
                Tentar de novo
              </button>
            )}
          </div>
          <p className="pk-status" role="status">
            {status}
          </p>
        </div>
        {/* A chave troca a cada pacote: as figurinhas são remontadas e "saem" de novo. */}
        <ul className="pk-row" key={`row-${page}`} data-open={opened && items.length > 0}>
          {Array.from({ length: PACK_SIZE }, (_, i) => {
            const s = items[i];
            if (!s) {
              return <li key={`slot-${i}`} className="pk-slot" aria-hidden="true" />;
            }
            // A imagem, como no cartão do app: a do portfólio de quem presta; sem ela, a foto da
            // categoria; sem foto de categoria, o desenho dela (que fica sempre por baixo).
            const slug = roots.get(s.categoryId)?.slug;
            const stock = categoryPhoto(slug, s.id);
            const cover = s.ownerCoverUrl
              ? mediaVariant(s.ownerCoverUrl, MEDIA_THUMB.card)
              : (stock?.src ?? null);
            const { Icon } = categoryArt(slug);
            const isFoil = i === foil;
            return (
              <li key={s.id} className="pk-slot is-filled" style={{ ['--i' as string]: i }}>
                <Link
                  to={`/servicos/${s.id}`}
                  className={`al-sticker pk-sticker al-g-${GROUNDS[i % GROUNDS.length]}${isFoil ? ' al-foil' : ''}`}
                  {...(isFoil ? HOLO : {})}
                >
                  <span className="al-sticker-n" aria-hidden="true">
                    {String((page - 1) * PACK_SIZE + i + 1).padStart(2, '0')}
                  </span>
                  <span className="al-sticker-photo">
                    <span className="pk-icon" aria-hidden="true">
                      <Icon size={56} strokeWidth={1.5} />
                    </span>
                    {/* Se a imagem não carregar, ela sai e fica o desenho que está por baixo. */}
                    {cover && (
                      <img
                        src={cover}
                        srcSet={s.ownerCoverUrl ? undefined : stock?.srcSet}
                        sizes="12rem"
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(e) => e.currentTarget.remove()}
                      />
                    )}
                  </span>
                  <span className="al-sticker-band">
                    <span className="al-sticker-title">{s.title}</span>
                    {s.ownerName && <span className="al-sticker-who">{s.ownerName}</span>}
                  </span>
                  <span className="al-sticker-value">{servicePrice(s)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
