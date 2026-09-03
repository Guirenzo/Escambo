import { useState, type FormEvent } from 'react';
import type { Category, Service } from '@escambo/types';
import { Button, Field, Input, PageHeader, QueryState, Select } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { brl } from '../../lib/format';
import { useCategories, useCreateService, useServices } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { BoostModal } from '../services/BoostModal';
import { ContratarModal } from '../services/ContratarModal';

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

export function ServicosView() {
  const { user } = useAuth();
  const myId = user?.id ?? -1;
  const toast = useToast();

  // busca (texto + descoberta local)
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<string | undefined>(undefined);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [radiusKm, setRadiusKm] = useState(25);
  const [locating, setLocating] = useState(false);
  const services = useServices({ q: submitted, ...(geo ? { lat: geo.lat, lng: geo.lng, radiusKm } : {}) });

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
    <div className="view">
      <PageHeader
        title="Serviços"
        action={<Button onClick={() => setOpen((o) => !o)}>{open ? 'Fechar' : '+ Novo serviço'}</Button>}
      />

      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim() || undefined);
        }}
      >
        <Input placeholder="Buscar serviços…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button variant="dark" type="submit">
          Buscar
        </Button>
      </form>

      {/* Descoberta local (diferencial #2) */}
      <div className="geo-bar">
        <Button variant="ghost" className={`toggle ${geo ? 'on' : ''}`} onClick={toggleNearMe} disabled={locating}>
          📍 {locating ? 'Localizando…' : geo ? 'Perto de mim: ativo' : 'Perto de mim'}
        </Button>
        {geo && (
          <>
            <span className="muted hint">raio</span>
            <Select value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} aria-label="Raio em km">
              {RADII.map((r) => (
                <option key={r} value={r}>
                  {r} km
                </option>
              ))}
            </Select>
            <span className="muted hint">ordenado por proximidade</span>
          </>
        )}
      </div>

      {open && (
        <form className="card" onSubmit={submit}>
          <h3>Novo serviço</h3>
          <Field label="Título">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
          </Field>
          <Field label="Categoria">
            <Select value={effectiveCategory} onChange={(e) => setCategoryId(Number(e.target.value))}>
              {flat.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Descrição">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} required minLength={10} />
          </Field>
          <Field label="Preço (R$)">
            <Input type="number" min={10} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Salvando…' : 'Publicar'}
          </Button>
        </form>
      )}

      <QueryState
        isLoading={services.isLoading}
        error={services.error}
        data={services.data}
        isEmpty={(d) => d.items.length === 0}
        empty={geo ? `Nenhum serviço num raio de ${radiusKm} km — aumente o raio.` : 'Nenhum serviço encontrado.'}
        onRetry={() => void services.refetch()}
      >
        {(d) => (
          <div className="cards-grid">
            {d.items.map((s) => {
              const mine = s.ownerId === myId;
              return (
                <div key={s.id} className="card service">
                  <div className="svc-top">
                    <strong>{s.title}</strong>
                    <span>
                      {s.boosted && <span className="chip level">🚀 Destaque</span>}{' '}
                      {s.isRemote && <span className="tag">remoto</span>}
                    </span>
                  </div>
                  <p className="muted clamp">{s.description}</p>
                  <div className="svc-foot">
                    <span className="price">{s.price != null ? brl(s.price) : 'a combinar'}</span>
                    <span className="muted">
                      {s.distanceKm != null
                        ? `📍 ${s.distanceKm} km`
                        : s.deliveryDays != null
                          ? `${s.deliveryDays} dias`
                          : ''}
                    </span>
                  </div>
                  <div className="svc-actions">
                    {mine ? (
                      <Button variant="mini" onClick={() => setBoost(s)} disabled={s.boosted}>
                        {s.boosted ? '🚀 Impulsionado' : '🚀 Impulsionar'}
                      </Button>
                    ) : (
                      <Button variant="mini" onClick={() => setContratar(s)}>
                        Contratar
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </QueryState>

      {contratar && <ContratarModal service={contratar} onClose={() => setContratar(null)} />}
      {boost && <BoostModal service={boost} onClose={() => setBoost(null)} />}
    </div>
  );
}
