import { useEffect, useState, type FormEvent } from 'react';
import type { Category, Service } from '@escambo/types';
import { api } from '../../lib/api';
import { brl } from '../../lib/format';

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
  const [services, setServices] = useState<Service[]>([]);
  const [cats, setCats] = useState<{ id: number; label: string }[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(0);
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(query?: string) {
    void api
      .listServices(query)
      .then((r) => setServices(r.items))
      .catch(() => undefined);
  }
  useEffect(() => {
    load();
    void api
      .categories()
      .then((cs) => {
        const flat = flatten(cs);
        setCats(flat);
        if (flat[0]) setCategoryId(flat[0].id);
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createService({
        categoryId,
        title,
        description,
        priceType: 'fixed',
        price: Number(price),
        isRemote: true,
      });
      setOpen(false);
      setTitle('');
      setDescription('');
      setPrice('');
      load();
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro ao publicar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view">
      <div className="view-head">
        <h2>Serviços</h2>
        <button onClick={() => setOpen((o) => !o)}>{open ? 'Fechar' : '+ Novo serviço'}</button>
      </div>

      <div className="searchbar">
        <input placeholder="Buscar serviços…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="dark" onClick={() => load(q || undefined)}>
          Buscar
        </button>
      </div>

      {open && (
        <form className="card" onSubmit={submit}>
          <h3>Novo serviço</h3>
          <label>
            Título
            <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
          </label>
          <label>
            Categoria
            <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Descrição
            <input value={description} onChange={(e) => setDescription(e.target.value)} required minLength={10} />
          </label>
          <label>
            Preço (R$)
            <input type="number" min={10} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={saving}>
            {saving ? 'Salvando…' : 'Publicar'}
          </button>
        </form>
      )}

      <div className="cards-grid">
        {services.length === 0 ? (
          <p className="muted">Nenhum serviço encontrado.</p>
        ) : (
          services.map((s) => (
            <div key={s.id} className="card service">
              <div className="svc-top">
                <strong>{s.title}</strong>
                {s.isRemote && <span className="tag">remoto</span>}
              </div>
              <p className="muted clamp">{s.description}</p>
              <div className="svc-foot">
                <span className="price">{s.price != null ? brl(s.price) : 'a combinar'}</span>
                {s.deliveryDays != null && <span className="muted">{s.deliveryDays} dias</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
