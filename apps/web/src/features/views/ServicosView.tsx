import { useState, type FormEvent } from 'react';
import type { Category } from '@escambo/types';
import { Button, Field, Input, PageHeader, QueryState, Select } from '../../components/ui';
import { brl } from '../../lib/format';
import { useCategories, useCreateService, useServices } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

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

export function ServicosView() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<string | undefined>(undefined);
  const services = useServices(submitted);
  const categories = useCategories();
  const create = useCreateService();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(0);
  const [price, setPrice] = useState('');

  const flat = categories.data ? flatten(categories.data) : [];
  const effectiveCategory = categoryId || flat[0]?.id || 0;

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
        empty="Nenhum serviço encontrado."
        onRetry={() => void services.refetch()}
      >
        {(d) => (
          <div className="cards-grid">
            {d.items.map((s) => (
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
                    {s.distanceKm != null ? `${s.distanceKm} km` : s.deliveryDays != null ? `${s.deliveryDays} dias` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}
