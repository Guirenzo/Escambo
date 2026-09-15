import { Heart, MapPin, Plus, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent, useEffect } from 'react';
import type {
  AvailabilityPeriod,
  Category,
  SavedSearch,
  SavedSearchFilters,
  Service,
} from '@escambo/types';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import {
  useCategories,
  useCreateService,
  useFavorites,
  usePublicSettings,
  useServicesInfinite,
  useToggleFavorite,
  useSavedSearches,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { BoostModal } from '../services/BoostModal';
import { ContratarModal } from '../services/ContratarModal';
import { SavedSearchesBar, SaveSearchButton } from '../services/SavedSearches';
import { ServiceCard } from '../services/ServiceCard';
import { brl, PERIOD_LABEL, PERIOD_ORDER, WEEKDAY_SHORT } from '../../lib/format';

function flatten(
  cats: Category[],
  depth = 0,
  acc: { id: number; label: string }[] = [],
): { id: number; label: string }[] {
  for (const c of cats) {
    acc.push({ id: c.id, label: `${'— '.repeat(depth)}${c.name}` });
    if (c.children.length) flatten(c.children, depth + 1, acc);
  }
  return acc;
}

type Geo = { lat: number; lng: number };
const RADII = [5, 10, 25, 50, 100];

type Sort = 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest' | 'distance';
const SORTS: { key: Sort; label: string; geoOnly?: boolean }[] = [
  { key: 'relevance', label: 'Relevância' },
  { key: 'price_asc', label: 'Menor preço' },
  { key: 'price_desc', label: 'Maior preço' },
  { key: 'rating', label: 'Melhor avaliados' },
  { key: 'newest', label: 'Mais recentes' },
  { key: 'distance', label: 'Mais perto', geoOnly: true },
];
const DELIVERY_OPTIONS = [3, 7, 15, 30];
/** Dia da semana de hoje (0=domingo), para marcar "(hoje)" no filtro de atendimento. */
const TODAY = new Date().getDay();
const RATING_OPTIONS = [3, 4, 4.5];

interface Filters {
  minPrice: string;
  maxPrice: string;
  maxDeliveryDays: number;
  minRating: number;
  /** Dia em que o prestador atende (0–6); -1 = qualquer. */
  day: number;
  /** Período do dia (só com o dia escolhido); '' = qualquer. */
  period: '' | AvailabilityPeriod;
  /** Só quem atende agora (Brasília). */
  now: boolean;
  sort: Sort;
}
const NO_FILTERS: Filters = {
  minPrice: '',
  maxPrice: '',
  maxDeliveryDays: 0,
  minRating: 0,
  day: -1,
  period: '',
  now: false,
  sort: 'relevance',
};

export function ServicosView() {
  usePageTitle('Serviços');
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const isFreelancer = user?.role === 'freelancer';
  const navigate = useNavigate();
  const toast = useToast();
  const minServicePrice = usePublicSettings().data?.minServicePrice ?? 10;

  // busca (texto + descoberta local)
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<string | undefined>(undefined);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [radiusKm, setRadiusKm] = useState(25);
  const [locating, setLocating] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(0);
  // filtros e ordenação: aplicam na hora (entram na chave da consulta)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const setFilter = (patch: Partial<Filters>): void => setFilters((f) => ({ ...f, ...patch }));
  const hasFilters =
    filters.minPrice !== '' ||
    filters.maxPrice !== '' ||
    filters.maxDeliveryDays > 0 ||
    filters.minRating > 0 ||
    filters.day >= 0 ||
    filters.now ||
    filters.sort !== 'relevance';
  const services = useServicesInfinite({
    q: submitted,
    ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    ...(geo ? { lat: geo.lat, lng: geo.lng, radiusKm } : {}),
    ...(filters.minPrice !== '' ? { minPrice: Number(filters.minPrice) } : {}),
    ...(filters.maxPrice !== '' ? { maxPrice: Number(filters.maxPrice) } : {}),
    ...(filters.maxDeliveryDays ? { maxDeliveryDays: filters.maxDeliveryDays } : {}),
    ...(filters.minRating ? { minRating: filters.minRating } : {}),
    ...(filters.day >= 0 ? { day: filters.day } : {}),
    ...(filters.day >= 0 && filters.period ? { period: filters.period } : {}),
    ...(filters.now ? { now: true } : {}),
    ...(filters.sort !== 'relevance' ? { sort: filters.sort } : {}),
  });

  // favoritos (serviços): coração no card + filtro "Só favoritos"
  const favorites = useFavorites();
  const toggleFav = useToggleFavorite();
  const [onlyFavs, setOnlyFavs] = useState(false);
  const favIds = useMemo(
    () =>
      new Set(
        (favorites.data ?? []).filter((f) => f.targetType === 'service').map((f) => f.targetId),
      ),
    [favorites.data],
  );

  // novo serviço
  const categories = useCategories();
  const create = useCreateService();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(0);
  const [price, setPrice] = useState('');
  const flat = categories.data ? flatten(categories.data) : [];
  const effectiveCategory = categoryId || flat[0]?.id || 0;

  // modais dos diferenciais
  const [contratar, setContratar] = useState<Service | null>(null);
  const [boost, setBoost] = useState<Service | null>(null);

  // Busca atual no formato de busca salva (ADR 35): o que a lista está mostrando agora.
  const currentSearch = useMemo(() => {
    const f: SavedSearchFilters = {};
    if (categoryFilter) f.categoryId = categoryFilter;
    if (geo) {
      f.lat = geo.lat;
      f.lng = geo.lng;
      f.radiusKm = radiusKm;
    }
    if (filters.minPrice !== '') f.minPrice = Number(filters.minPrice);
    if (filters.maxPrice !== '') f.maxPrice = Number(filters.maxPrice);
    if (filters.maxDeliveryDays) f.maxDeliveryDays = filters.maxDeliveryDays;
    if (filters.minRating) f.minRating = filters.minRating;
    if (filters.day >= 0) {
      f.day = filters.day;
      if (filters.period) f.period = filters.period;
    }
    return { query: submitted ?? null, filters: f };
  }, [categoryFilter, geo, radiusKm, filters, submitted]);

  /** Aplica uma busca salva: texto, categoria, localização e filtros voltam como foram salvos. */
  function applySaved(s: SavedSearch): void {
    const f = s.filters ?? {};
    setQ(s.query ?? '');
    setSubmitted(s.query ?? undefined);
    setCategoryFilter(f.categoryId ?? 0);
    setGeo(f.lat !== undefined && f.lng !== undefined ? { lat: f.lat, lng: f.lng } : null);
    if (f.radiusKm) setRadiusKm(f.radiusKm);
    setOnlyFavs(false);
    setFilters({
      ...NO_FILTERS,
      minPrice: f.minPrice !== undefined ? String(f.minPrice) : '',
      maxPrice: f.maxPrice !== undefined ? String(f.maxPrice) : '',
      maxDeliveryDays: f.maxDeliveryDays ?? 0,
      minRating: f.minRating ?? 0,
      day: f.day ?? -1,
      period: f.day !== undefined ? (f.period ?? '') : '',
    });
  }

  // Link do alerta (/servicos?busca=ID): aplica a busca salva uma vez e limpa a URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const savedList = useSavedSearches();
  useEffect(() => {
    const id = Number(searchParams.get('busca'));
    if (!id || !savedList.data) return;
    const found = savedList.data.find((s) => s.id === id);
    if (found) applySaved(found);
    else toast.error('Essa busca salva não existe mais.');
    setSearchParams({}, { replace: true });
  }, [searchParams, savedList.data]);

  function toggleNearMe(): void {
    if (geo) {
      setGeo(null);
      return;
    }
    if (!('geolocation' in navigator)) {
      toast.error('Seu navegador não oferece geolocalização');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        toast.error('Não consegui obter sua localização');
        setLocating(false);
      },
      { timeout: 8000 },
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await create.mutateAsync({
        categoryId: effectiveCategory,
        title,
        description,
        priceType: 'fixed',
        price: Number(price),
        isRemote: true,
      });
      toast.success('Serviço publicado!');
      setOpen(false);
      setTitle('');
      setDescription('');
      setPrice('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao publicar');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Serviços"
        subtitle="Encontre quem faz — ou publique o que você faz."
        action={
          <Button variant={open ? 'secondary' : 'primary'} onClick={() => setOpen((o) => !o)}>
            <Plus size={16} /> {open ? 'Fechar' : 'Novo serviço'}
          </Button>
        }
      />

      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim() || undefined);
        }}
      >
        <Input placeholder="Buscar serviços…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select
          aria-label="Categoria"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(Number(e.target.value))}
        >
          <option value={0}>Todas as categorias</option>
          {flat.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button variant="secondary" type="submit">
          <Search size={16} /> Buscar
        </Button>
      </form>

      {/* Descoberta local (diferencial #2) */}
      <div className="geo-bar">
        <Button
          variant="ghost"
          className={`toggle ${geo ? 'on' : ''}`}
          onClick={toggleNearMe}
          disabled={locating}
        >
          <MapPin size={16} />{' '}
          {locating ? 'Localizando…' : geo ? 'Perto de mim: ativo' : 'Perto de mim'}
        </Button>
        {geo && (
          <>
            <span className="muted hint">raio</span>
            <Select
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              aria-label="Raio em km"
            >
              {RADII.map((r) => (
                <option key={r} value={r}>
                  {r} km
                </option>
              ))}
            </Select>
            {filters.sort === 'relevance' && (
              <span className="muted hint">ordenado por proximidade</span>
            )}
          </>
        )}
        <Button
          variant="ghost"
          className={`toggle ${onlyFavs ? 'on' : ''}`}
          aria-pressed={onlyFavs}
          onClick={() => setOnlyFavs((v) => !v)}
        >
          <Heart size={16} /> Só favoritos{favIds.size ? ` (${favIds.size})` : ''}
        </Button>
        {/* Atende agora (ADR 34): aceitando pedidos, no dia e no período de agora em Brasília */}
        <Button
          variant="ghost"
          className={`toggle ${filters.now ? 'on' : ''}`}
          aria-pressed={filters.now}
          title="Aceitando pedidos, no dia e no período de agora (horário de Brasília)"
          onClick={() => setFilter({ now: !filters.now })}
        >
          <span className="now-dot" aria-hidden="true" /> Atende agora
        </Button>
        <SaveSearchButton current={currentSearch} disabled={onlyFavs} />
      </div>
      <SavedSearchesBar onApply={applySaved} />

      {/* Filtros e ordenação (aplicam na hora) */}
      <div className="filters-bar" data-testid="filters">
        <label className="filter">
          <span>Preço de</span>
          <Input
            type="number"
            min={0}
            step="1"
            placeholder="R$"
            aria-label="Preço mínimo"
            value={filters.minPrice}
            onChange={(e) => setFilter({ minPrice: e.target.value })}
          />
        </label>
        <label className="filter">
          <span>até</span>
          <Input
            type="number"
            min={0}
            step="1"
            placeholder="R$"
            aria-label="Preço máximo"
            value={filters.maxPrice}
            onChange={(e) => setFilter({ maxPrice: e.target.value })}
          />
        </label>
        <label className="filter">
          <span>Prazo</span>
          <Select
            aria-label="Prazo máximo"
            value={filters.maxDeliveryDays}
            onChange={(e) => setFilter({ maxDeliveryDays: Number(e.target.value) })}
          >
            <option value={0}>qualquer</option>
            {DELIVERY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                até {d} dias
              </option>
            ))}
          </Select>
        </label>
        <label className="filter">
          <span>Nota</span>
          <Select
            aria-label="Nota mínima"
            value={filters.minRating}
            onChange={(e) => setFilter({ minRating: Number(e.target.value) })}
          >
            <option value={0}>qualquer</option>
            {RATING_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}+ estrelas
              </option>
            ))}
          </Select>
        </label>
        <label className="filter">
          <span>Atende</span>
          <Select
            aria-label="Atende no dia"
            value={filters.day}
            onChange={(e) => {
              const day = Number(e.target.value);
              setFilter(day < 0 ? { day, period: '' } : { day });
            }}
          >
            <option value={-1}>qualquer dia</option>
            {WEEKDAY_SHORT.map((label, d) => (
              <option key={d} value={d}>
                {label}
                {d === TODAY ? ' (hoje)' : ''}
              </option>
            ))}
          </Select>
        </label>
        <label className="filter">
          <span>Período</span>
          <Select
            aria-label="Período do dia"
            value={filters.period}
            disabled={filters.day < 0}
            title={filters.day < 0 ? 'Escolha o dia primeiro' : undefined}
            onChange={(e) => setFilter({ period: e.target.value as Filters['period'] })}
          >
            <option value="">qualquer período</option>
            {PERIOD_ORDER.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
              </option>
            ))}
          </Select>
        </label>
        <label className="filter">
          <span>Ordenar</span>
          <Select
            aria-label="Ordenar por"
            value={filters.sort}
            onChange={(e) => setFilter({ sort: e.target.value as Sort })}
          >
            {SORTS.filter((s) => !s.geoOnly || geo).map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
        {hasFilters && (
          <Button variant="ghost" className="mini" onClick={() => setFilters(NO_FILTERS)}>
            Limpar filtros
          </Button>
        )}
      </div>

      {open && (
        <form className="card" onSubmit={submit}>
          <h3>Novo serviço</h3>
          <Field label="Título">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
            />
          </Field>
          <Field label="Categoria">
            <Select
              value={effectiveCategory}
              onChange={(e) => setCategoryId(Number(e.target.value))}
            >
              {flat.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Descrição">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              minLength={10}
            />
          </Field>
          <Field label={`Preço (R$) · mínimo ${brl(minServicePrice)}`}>
            <Input
              type="number"
              min={minServicePrice}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Salvando…' : 'Publicar'}
          </Button>
        </form>
      )}

      {services.isLoading ? (
        <Skeleton lines={6} />
      ) : services.error ? (
        <ErrorState error={services.error} onRetry={() => void services.refetch()} />
      ) : (
        (() => {
          const all = services.data?.pages.flatMap((p) => p.items) ?? [];
          const items = onlyFavs ? all.filter((s) => favIds.has(s.id)) : all;
          if (items.length === 0) {
            return (
              <EmptyState>
                {onlyFavs
                  ? 'Nenhum favorito nesta lista. Marque o coração nos serviços.'
                  : hasFilters
                    ? 'Nenhum serviço com esses filtros — afrouxe o preço, o prazo ou a nota.'
                    : geo
                      ? `Nenhum serviço num raio de ${radiusKm} km — aumente o raio.`
                      : 'Nenhum serviço encontrado.'}
              </EmptyState>
            );
          }
          return (
            <>
              <div className="cards-grid">
                {items.map((s) => (
                  <ServiceCard
                    key={s.id}
                    service={s}
                    mine={s.ownerId === myId}
                    onContratar={setContratar}
                    onBoost={setBoost}
                    favorited={favIds.has(s.id)}
                    onToggleFavorite={(svc) =>
                      toggleFav.mutate({
                        targetType: 'service',
                        targetId: svc.id,
                        favorited: favIds.has(svc.id),
                      })
                    }
                    onProposeBarter={
                      isFreelancer ? (svc) => navigate(`/trocas?propor=${svc.id}`) : undefined
                    }
                  />
                ))}
              </div>
              {services.hasNextPage && !onlyFavs && (
                <div className="center" style={{ marginTop: 16 }}>
                  <Button
                    variant="secondary"
                    onClick={() => void services.fetchNextPage()}
                    disabled={services.isFetchingNextPage}
                  >
                    {services.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
                  </Button>
                </div>
              )}
            </>
          );
        })()
      )}

      {contratar && <ContratarModal service={contratar} onClose={() => setContratar(null)} />}
      {boost && <BoostModal service={boost} onClose={() => setBoost(null)} />}
    </div>
  );
}
