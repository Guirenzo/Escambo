import { Bell, BellOff, Bookmark, BookmarkPlus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { SavedSearch, SavedSearchFilters } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { useSavedSearchMutations, useSavedSearches } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** A busca que a lista está mostrando agora, no formato de busca salva (ADR 35). */
export interface CurrentSearch {
  query: string | null;
  filters: SavedSearchFilters;
}

/** Resumo curto: o texto buscado e quantos filtros. */
function summary(s: { query: string | null; filters: SavedSearchFilters | null }): string {
  const n = Object.keys(s.filters ?? {}).length;
  return [s.query ? `“${s.query}”` : null, n ? `${n} filtro${n > 1 ? 's' : ''}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** Botão "Salvar busca" com o formulário de nome e alerta. */
export function SaveSearchButton({
  current,
  disabled,
}: {
  current: CurrentSearch;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [alert, setAlert] = useState(true);
  const { create } = useSavedSearchMutations();
  const toast = useToast();
  const empty = !current.query && Object.keys(current.filters).length === 0;

  function start(): void {
    setName(current.query ?? '');
    setAlert(true);
    setOpen(true);
  }

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await create.mutateAsync({
        name: name.trim() || null,
        query: current.query,
        filters: current.filters,
        alertEnabled: alert,
      });
      toast.success(alert ? 'Busca salva. Avisamos quando aparecer serviço novo.' : 'Busca salva.');
      setOpen(false);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar a busca');
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        className="toggle"
        onClick={start}
        disabled={disabled || empty}
        title={empty ? 'Busque um texto ou escolha um filtro para salvar' : undefined}
      >
        <BookmarkPlus size={16} /> Salvar busca
      </Button>
      {open && (
        <Modal title="Salvar busca" onClose={() => setOpen(false)}>
          <form className="stack" onSubmit={save}>
            <p className="muted tiny">{summary(current)}</p>
            <Field label="Nome">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="Ex.: Logo até R$ 500"
              />
            </Field>
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="Me avisar de serviços novos"
                checked={alert}
                onChange={(e) => setAlert(e.target.checked)}
              />
              <span>Me avisar de serviços novos (no máximo um aviso por hora)</span>
            </label>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}

/** Linha das buscas salvas: aplicar com um clique, ligar/desligar o alerta e apagar. */
export function SavedSearchesBar({ onApply }: { onApply: (s: SavedSearch) => void }) {
  const saved = useSavedSearches();
  const { update, remove } = useSavedSearchMutations();
  const toast = useToast();
  const items = saved.data ?? [];
  if (items.length === 0) return null;

  async function toggle(s: SavedSearch): Promise<void> {
    try {
      await update.mutateAsync({ id: s.id, alertEnabled: !s.alertEnabled });
      toast.info(
        s.alertEnabled ? 'Alerta desligado.' : 'Alerta ligado: avisamos de serviços novos.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível alterar o alerta');
    }
  }

  async function drop(s: SavedSearch): Promise<void> {
    try {
      await remove.mutateAsync(s.id);
      toast.success('Busca apagada.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível apagar a busca');
    }
  }

  return (
    <div className="saved-bar" data-testid="saved-searches" role="group" aria-label="Buscas salvas">
      <span className="muted tiny saved-label">
        <Bookmark size={14} aria-hidden="true" /> Salvas
      </span>
      {items.map((s) => {
        const label = s.name || s.query || 'Busca salva';
        return (
          <span key={s.id} className="saved-chip">
            <button
              type="button"
              className="saved-apply"
              onClick={() => onApply(s)}
              title={summary(s)}
            >
              {label}
            </button>
            <button
              type="button"
              className={`icon-btn saved-bell ${s.alertEnabled ? 'on' : ''}`}
              aria-pressed={s.alertEnabled}
              aria-label={`Alerta de ${label}`}
              onClick={() => void toggle(s)}
            >
              {s.alertEnabled ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Apagar ${label}`}
              onClick={() => void drop(s)}
            >
              <X size={14} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
