import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LocateFixed, MapPin } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useProfilesMe } from '../../lib/hooks';
import { scrollBehavior } from '../../lib/motion';
import { useToast } from '../../lib/toast';
import { useCategoryRoots } from '../services/categoryArt';
import { ServiceCard } from '../services/ServiceCard';

type Geo = { lat: number; lng: number };

/** Raio do "Perto de você" no Início; a busca de Serviços deixa escolher outro. */
export const NEARBY_RADIUS_KM = 50;
const LIMIT = 12;

/**
 * "Perto de você" no Início: serviços de verdade, do mais perto para o mais longe, a partir da
 * localização do perfil de freelancer. Sem ela, mostra os mais recentes e oferece usar a localização
 * do navegador, pedida só no clique (e só para ordenar: não é gravada). Carrossel com rolagem
 * nativa, botões anterior/próximo e o teclado andando pelos links dos cartões.
 */
export function NearbyServices() {
  const { user } = useAuth();
  const toast = useToast();
  const profiles = useProfilesMe();
  const fl = profiles.data?.freelancer;
  const profileGeo: Geo | null =
    fl?.latitude != null && fl.longitude != null ? { lat: fl.latitude, lng: fl.longitude } : null;
  const [browserGeo, setBrowserGeo] = useState<Geo | null>(null);
  const [locating, setLocating] = useState(false);
  const geo = browserGeo ?? profileGeo;
  const params = geo
    ? { lat: geo.lat, lng: geo.lng, radiusKm: NEARBY_RADIUS_KM, sort: 'distance' as const }
    : {};
  // Espera o perfil: quem tem localização nele não vê a lista "sem localização" piscar antes.
  const list = useQuery({
    queryKey: ['services', 'nearby', params],
    queryFn: () => api.listServices({ ...params, limit: LIMIT }),
    enabled: !profiles.isLoading,
  });
  const roots = useCategoryRoots();
  const items = (list.data?.items ?? []).filter((s) => s.ownerId !== user?.id);

  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, items.length]);

  function page(direction: 1 | -1): void {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: scrollBehavior() });
  }

  function locate(): void {
    if (!('geolocation' in navigator)) {
      toast.error('Seu navegador não oferece geolocalização');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBrowserGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        toast.error('Não consegui obter sua localização');
        setLocating(false);
      },
      { timeout: 8000 },
    );
  }

  const subtitle = geo
    ? browserGeo
      ? `Pela sua localização de agora, até ${NEARBY_RADIUS_KM} km.`
      : `Até ${NEARBY_RADIUS_KM} km${fl?.city ? ` de ${fl.city}` : ' de você'}, pela localização do seu perfil.`
    : 'Os serviços mais recentes do Escambo.';

  return (
    <section className="section" aria-labelledby="nearby-title">
      <div className="section-head">
        <div>
          <h2 id="nearby-title">{geo ? 'Perto de você' : 'Descubra serviços'}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="section-tools">
          {items.length > 0 && (
            <>
              <Button
                variant="secondary"
                className="round-btn"
                aria-label="Ver os anteriores"
                disabled={edges.start}
                onClick={() => page(-1)}
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </Button>
              <Button
                variant="secondary"
                className="round-btn"
                aria-label="Ver os próximos"
                disabled={edges.end}
                onClick={() => page(1)}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </Button>
              <Link to="/servicos" className="btn secondary sm">
                Ver todos
              </Link>
            </>
          )}
        </div>
      </div>

      {!geo && (
        <div className="locate-cta">
          <span className="locate-ico" aria-hidden="true">
            <MapPin size={20} />
          </span>
          <div>
            <strong>Veja quem atende perto de você</strong>
            <p>A localização só ordena a lista por distância e não fica salva.</p>
          </div>
          <Button variant="secondary" onClick={locate} loading={locating}>
            {!locating && <LocateFixed size={16} aria-hidden="true" />}
            {locating ? 'Localizando…' : 'Usar minha localização'}
          </Button>
        </div>
      )}

      {list.isLoading || profiles.isLoading ? (
        <Skeleton lines={3} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={geo ? 'Ninguém por perto ainda' : 'Nenhum serviço publicado ainda'}
          action={
            <Link to="/servicos" className="btn secondary sm">
              Ver todos
            </Link>
          }
        >
          {geo
            ? `Nenhum serviço num raio de ${NEARBY_RADIUS_KM} km. Os remotos atendem de qualquer lugar.`
            : 'Quando alguém publicar um serviço, ele aparece aqui.'}
        </EmptyState>
      ) : (
        <div className="carousel" ref={track} onScroll={measure}>
          {items.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              mine={false}
              compact
              categorySlug={roots.get(s.categoryId)?.slug}
              categoryName={roots.get(s.categoryId)?.name}
            />
          ))}
        </div>
      )}
    </section>
  );
}
