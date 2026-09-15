import { Bell, BellOff, Bookmark, BookmarkPlus, Pencil, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type {
  SavedSearch,
  SavedSearchAlertFrequency,
  SavedSearchFilters,
  UpdateSavedSearchRequest,
} from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { useSavedSearchMutations, useSavedSearches } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import {
  ALERT_FREQUENCY_OPTIONS,
  alertFrequencyLabel,
  alertNotice,
  DEFAULT_ALERT_FREQUENCY,
} from './alertFrequency';

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

/**
 * Liga/desliga o alerta e escolhe a frequência (ADR 37). Com o alerta desligado as opções ficam
 * visíveis e inativas, e a escolha continua guardada para quando ele voltar.
 */
function AlertFields({
  enabled,
  frequency,
  onEnabled,
  onFrequency,
}: {
  enabled: boolean;
  frequency: SavedSearchAlertFrequency;
  onEnabled: (v: boolean) => void;
  onFrequency: (v: SavedSearchAlertFrequency) => void;
}) {
  const group = useId();
  return (
    <>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label="Me avisar de serviços novos"
          checked={enabled}
          onChange={(e) => onEnabled(e.target.checked)}
        />
        <span>Me avisar de serviços novos</span>
      </label>
      <fieldset className="pref-list alert-frequency" disabled={!enabled}>
        <legend className="muted tiny">Com que frequência</legend>
        {ALERT_FREQUENCY_OPTIONS.map((o) => (
          <label key={o.value} className={enabled && frequency === o.value ? 'on' : ''}>
            <input
              type="radio"
              name={group}
              value={o.value}
              checked={frequency === o.value}
              onChange={() => onFrequency(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="muted tiny">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

/** Botão "Salvar busca" com o formulário de nome, alerta e frequência. */
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
  const [frequency, setFrequency] = useState<SavedSearchAlertFrequency>(DEFAULT_ALERT_FREQUENCY);
  const { create } = useSavedSearchMutations();
  const toast = useToast();
  const empty = !current.query && Object.keys(current.filters).length === 0;

  function start(): void {
    setName(current.query ?? '');
    setAlert(true);
    setFrequency(DEFAULT_ALERT_FREQUENCY);
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
        alertFrequency: frequency,
      });
      toast.success(alert ? `Busca salva. ${alertNotice(frequency)}` : 'Busca salva.');
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
            <AlertFields
              enabled={alert}
              frequency={frequency}
              onEnabled={setAlert}
              onFrequency={setFrequency}
            />
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}

/** Editar uma busca salva: nome (vazio volta a mostrar o texto buscado), alerta e frequência. */
function EditSavedSearchModal({ search, onClose }: { search: SavedSearch; onClose: () => void }) {
  const [name, setName] = useState(search.name ?? '');
  const [alert, setAlert] = useState(search.alertEnabled);
  const [frequency, setFrequency] = useState(search.alertFrequency);
  const { update } = useSavedSearchMutations();
  const toast = useToast();

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    // Só vai o que mudou: sem religar o alerta, o PATCH não mexe no cursor.
    const body: UpdateSavedSearchRequest = {};
    const trimmed = name.trim();
    if (trimmed !== (search.name ?? '')) body.name = trimmed || null;
    if (alert !== search.alertEnabled) body.alertEnabled = alert;
    if (frequency !== search.alertFrequency) body.alertFrequency = frequency;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: search.id, ...body });
      const alertChanged = body.alertEnabled !== undefined || body.alertFrequency !== undefined;
      toast.success(
        alert && alertChanged
          ? `Busca atualizada. ${alertNotice(frequency)}`
          : body.alertEnabled === false
            ? 'Busca atualizada. Alerta desligado.'
            : 'Busca atualizada.',
      );
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar a busca');
    }
  }

  return (
    <Modal title="Editar busca" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <p className="muted tiny">{summary(search)}</p>
        <Field label="Nome">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder={search.query ?? 'Ex.: Logo até R$ 500'}
          />
        </Field>
        <AlertFields
          enabled={alert}
          frequency={frequency}
          onEnabled={setAlert}
          onFrequency={setFrequency}
        />
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Salvando…' : 'Salvar'}
        </Button>
      </form>
    </Modal>
  );
}

/** Linha das buscas salvas: aplicar com um clique, ligar/desligar o alerta, editar e apagar. */
export function SavedSearchesBar({ onApply }: { onApply: (s: SavedSearch) => void }) {
  const saved = useSavedSearches();
  const { update, remove } = useSavedSearchMutations();
  const [editing, setEditing] = useState<SavedSearch | null>(null);
  const toast = useToast();
  const items = saved.data ?? [];
  if (items.length === 0) return null;

  async function toggle(s: SavedSearch): Promise<void> {
    try {
      await update.mutateAsync({ id: s.id, alertEnabled: !s.alertEnabled });
      toast.info(
        s.alertEnabled ? 'Alerta desligado.' : `Alerta ligado. ${alertNotice(s.alertFrequency)}`,
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
              title={
                s.alertEnabled
                  ? `Alerta: ${alertFrequencyLabel(s.alertFrequency).toLowerCase()}`
                  : 'Alerta desligado'
              }
              onClick={() => void toggle(s)}
            >
              {s.alertEnabled ? <Bell size={14} /> : <BellOff size={14} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Editar ${label}`}
              onClick={() => setEditing(s)}
            >
              <Pencil size={14} />
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
      {editing && <EditSavedSearchModal search={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
