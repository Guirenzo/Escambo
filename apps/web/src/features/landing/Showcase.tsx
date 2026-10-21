import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LocateFixed, MapPin, Search, SearchX, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Category } from '@escambo/types';
import { Button, ErrorState } from '../../components/ui';
import { api, type ServiceQuery } from '../../lib/api';
import { rootsById } from '../services/categoryArt';
import { ServiceCard } from '../services/ServiceCard';

/** Quantos serviços a vitrine mostra; o resto está na busca do app. */
export const SHOWCASE_LIMIT = 8;
/** Raio do "Perto de você", o mesmo do Início do app. */
export const NEARBY_KM = 50;

export interface ShowcaseFilter {
  q: string;
  categoryId: number | null;
}

type Geo = { lat: number; lng: number };

/** O endereço da busca do app com o mesmo filtro (o app pede o login e volta para ela). */
export function searchPath({ q, categoryId }: ShowcaseFilter): string {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (categoryId !== null) qs.set('categoria', String(categoryId));
  const s = qs.toString();
  return s ? `/servicos?${s}` : '/servicos';
}

/** O nome de uma categoria (raiz ou subcategoria) na árvore. */
function nameOf(tree: Category[], id: number): string | undefined {
  for (const node of tree) {
    if (node.id === id) return node.name;
    const inside = nameOf(node.children ?? [], id);
    if (inside) return inside;
  }
  return undefined;
}

const count = (n: number): string => `${n} ${n === 1 ? 'serviço' : 'serviços'}`;

/** Esqueleto no formato do cartão enquanto a lista chega (decorativo: o status diz "carregando"). */
function CardSkeleton() {
  return (
    <div className="lp-show-skel" aria-hidden="true">
      <span className="lp-show-skel-cover" />
      <span className="lp-show-skel-line" />
      <span className="lp-show-skel-line short" />
    </div>
  );
}

/**
 * Vitrine da página inicial: serviços de verdade (GET /api/services é pública), filtrados pela
 * busca do topo. Sem localização, os mais recentes; com ela (pedida só no clique, e só para
 * ordenar: não é gravada), do mais perto para o mais longe. O cartão é o mesmo do app e leva ao
 * serviço, onde o app pede o login e volta. Sem resultado, um estado vazio com saída, nunca número
 * inventado.
 */
export function Showcase({
  filter,
  categories,
  onClearQuery,
  onClearCategory,
}: {
  filter: ShowcaseFilter;
  categories: Category[];
  onClearQuery: () => void;
  onClearCategory: () => void;
}) {
  const [geo, setGeo] = useState<Geo | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const roots = useMemo(() => rootsById(categories), [categories]);
  const categoryName =
    filter.categoryId === null ? null : (nameOf(categories, filter.categoryId) ?? null);

  const params: ServiceQuery = {
    ...(filter.q ? { q: filter.q } : {}),
    ...(filter.categoryId !== null ? { categoryId: filter.categoryId } : {}),
    ...(geo ? { lat: geo.lat, lng: geo.lng, radiusKm: NEARBY_KM, sort: 'distance' as const } : {}),
    limit: SHOWCASE_LIMIT,
  };
  const list = useQuery({
    queryKey: ['landing', 'showcase', params],
    queryFn: () => api.listServices(params),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const filtered = !!filter.q || filter.categoryId !== null;

  function locate(): void {
    setGeoError(null);
    if (!('geolocation' in navigator)) {
      setGeoError('Este navegador não oferece localização. A vitrine segue pelos mais recentes.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setGeoError('Não deu para usar a sua localização. A vitrine segue pelos mais recentes.');
        setLocating(false);
      },
      { timeout: 8000 },
    );
  }

  const title = geo ? 'Perto de você' : filtered ? 'Resultados da busca' : 'Descubra serviços';
  const subtitle = geo
    ? `Do mais perto para o mais longe, até ${NEARBY_KM} km. A localização só ordena a lista e não fica salva.`
    : filtered
      ? 'O que combina com a sua busca. Para contratar, você entra ou cria a sua conta.'
      : 'Os serviços publicados mais recentemente. Para ver quem atende perto, use a sua localização.';

  const status = list.isLoading
    ? 'Carregando serviços…'
    : list.error
      ? ''
      : items.length === 0
        ? 'Nenhum serviço encontrado.'
        : items.length === SHOWCASE_LIMIT
          ? `Os ${count(items.length)} mais ${geo ? 'próximos' : 'recentes'}.`
          : `${count(items.length)} encontrado${items.length === 1 ? '' : 's'}.`;

  return (
    <section className="lp-band lp-show" id="vitrine" aria-labelledby="vitrine-title">
      <div className="lp-wrap">
        <div className="lp-show-head">
          <div className="lp-head lp-head-tight">
            <p className="lp-kicker">Vitrine</p>
            <h2 id="vitrine-title" tabIndex={-1} data-hash-target="">
              {title}
            </h2>
            <p className="lp-sub">{subtitle}</p>
          </div>
          <div className="lp-show-tools">
            {!geo && (
              <Button variant="secondary" onClick={locate} loading={locating}>
                {!locating && <LocateFixed size={16} aria-hidden="true" />}
                {locating ? 'Localizando…' : 'Usar minha localização'}
              </Button>
            )}
            <Link to={searchPath(filter)} className="lp-btn lp-btn-quiet">
              Ver todos os serviços
            </Link>
          </div>
        </div>

        {(filter.q || categoryName || geo) && (
          <ul className="lp-filters" aria-label="Filtros da vitrine">
            {filter.q && (
              <li>
                <span className="lp-filter">
                  <Search size={14} aria-hidden="true" />“{filter.q}”
                  <button
                    type="button"
                    className="lp-filter-x"
                    aria-label={`Tirar a busca “${filter.q}”`}
                    onClick={onClearQuery}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </span>
              </li>
            )}
            {categoryName && (
              <li>
                <span className="lp-filter">
                  {categoryName}
                  <button
                    type="button"
                    className="lp-filter-x"
                    aria-label={`Tirar a categoria ${categoryName}`}
                    onClick={onClearCategory}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </span>
              </li>
            )}
            {geo && (
              <li>
                <span className="lp-filter">
                  <MapPin size={14} aria-hidden="true" />
                  Perto de você
                  <button
                    type="button"
                    className="lp-filter-x"
                    aria-label="Tirar a localização"
                    onClick={() => setGeo(null)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </span>
              </li>
            )}
          </ul>
        )}

        {geoError && (
          <p className="lp-show-alert" role="alert">
            {geoError}
          </p>
        )}
        <p className="lp-show-status" role="status" data-testid="vitrine-status">
          {status}
        </p>

        {list.isLoading ? (
          <div className="lp-show-grid">
            {Array.from({ length: 4 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <div className="lp-empty">
            <span className="lp-empty-ico" aria-hidden="true">
              {geo ? <MapPin size={26} /> : <SearchX size={26} />}
            </span>
            <p className="lp-empty-title">
              {filter.q
                ? `Nada encontrado para “${filter.q}”${categoryName ? ` em ${categoryName}` : ''}`
                : geo
                  ? 'Ninguém por perto ainda'
                  : categoryName
                    ? `Nenhum serviço em ${categoryName} ainda`
                    : 'Nenhum serviço publicado ainda'}
            </p>
            <p className="lp-empty-text">
              {geo
                ? `Nenhum serviço num raio de ${NEARBY_KM} km com esse filtro. Os remotos atendem de qualquer lugar.`
                : filtered
                  ? 'Tente outra palavra ou outra categoria. Se você faz esse serviço, publique o primeiro.'
                  : 'Quando alguém publicar um serviço, ele aparece aqui. Que tal ser o primeiro?'}
            </p>
            <div className="lp-empty-actions">
              {(filtered || geo) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onClearQuery();
                    onClearCategory();
                    setGeo(null);
                  }}
                >
                  Limpar os filtros
                </Button>
              )}
              <Link to="/cadastro?perfil=freelancer" className="lp-btn lp-btn-primary">
                Publicar o primeiro serviço
              </Link>
            </div>
          </div>
        ) : (
          <div className="lp-show-grid" aria-busy={list.isFetching || undefined}>
            {items.map((s) => (
              <ServiceCard
                key={s.id}
                service={s}
                mine={false}
                compact
                categorySlug={roots.get(s.categoryId)?.slug}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
