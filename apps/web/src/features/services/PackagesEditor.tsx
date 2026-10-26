import type { PackageTier, ServicePackage } from '@escambo/types';
import { Plus, Trash2, X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Field, Input, Select } from '../../components/ui';
import { brl } from '../../lib/format';
import {
  featureProblem,
  FEATURE_MAX,
  FEATURE_MIN,
  MAX_FEATURES,
  MIN_PACKAGE_PRICE,
  normalizeFeature,
  PACKAGE_DEFAULT_REVISIONS,
  PACKAGE_DESCRIPTION_MAX,
  PACKAGE_MAX_DELIVERY_DAYS,
  PACKAGE_MAX_REVISIONS,
  PACKAGE_NAME_MAX,
  PACKAGE_TIER_LABEL,
  PACKAGE_TIERS,
} from './packages';

/** Um pacote enquanto é editado: os números como o campo os guarda (texto). */
export interface PackageDraft {
  tier: PackageTier;
  name: string;
  description: string;
  price: string;
  deliveryDays: string;
  revisions: string;
  features: string[];
}

/** O pacote gravado como rascunho do formulário. */
export const draftOf = (p: ServicePackage): PackageDraft => ({
  tier: p.tier,
  name: p.name,
  description: p.description ?? '',
  price: String(p.price),
  deliveryDays: String(p.deliveryDays),
  revisions: String(p.revisions),
  features: [...p.features],
});

/** Um nível novo, com o nome do nível de partida e as 2 revisões de sempre (RN-023). */
export const newDraft = (
  tier: PackageTier,
  seed: { price?: string; deliveryDays?: string } = {},
): PackageDraft => ({
  tier,
  name: PACKAGE_TIER_LABEL[tier],
  description: '',
  price: seed.price ?? '',
  deliveryDays: seed.deliveryDays ?? '',
  revisions: String(PACKAGE_DEFAULT_REVISIONS),
  features: [],
});

/** Os rascunhos como a API recebe (o servidor ordena e confere de novo). */
export const toPackages = (drafts: readonly PackageDraft[]): ServicePackage[] =>
  drafts.map((d) => ({
    tier: d.tier,
    name: d.name.trim(),
    description: d.description.trim() || null,
    price: Number(d.price),
    deliveryDays: Number(d.deliveryDays),
    revisions: Number(d.revisions),
    features: d.features,
  }));

/**
 * Pacotes do serviço no formulário (RF-086, RN-068): um grupo de campos por nível, lado a lado na
 * tela larga e um embaixo do outro na estreita. Começa no Básico; "Adicionar" acrescenta o nível
 * seguinte, e só o último sai, para os níveis nunca pularem. O preço mínimo de cada nível é o maior
 * entre o mínimo da plataforma e o preço do nível de baixo: o navegador barra o envio e o aviso diz
 * o porquê, ligado ao campo.
 */
export function PackagesEditor({
  value,
  onChange,
  minPrice,
}: {
  value: PackageDraft[];
  onChange: (drafts: PackageDraft[]) => void;
  /** O mínimo do serviço no painel (RN-016); o da contratação (RN-027) vale se for maior. */
  minPrice: number;
}) {
  const id = useId();
  const next = PACKAGE_TIERS[value.length];
  const floor = Math.max(minPrice, MIN_PACKAGE_PRICE);

  function set(i: number, patch: Partial<PackageDraft>): void {
    onChange(value.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  }

  return (
    <div className="pkg-editor" data-testid="packages-editor">
      <p className="muted tiny" id={`${id}-hint`}>
        O anúncio mostra “a partir de” com o preço do Básico, e quem contrata escolhe o nível. O
        preço sobe (ou se mantém) do Básico ao Premium.
      </p>
      <div className={`pkg-editor-grid cols-${value.length}`}>
        {value.map((d, i) => {
          const lower = i > 0 ? Number(value[i - 1]!.price) : NaN;
          const min = Number.isFinite(lower) && lower > floor ? lower : floor;
          const price = Number(d.price);
          const orderProblem =
            d.price !== '' && Number.isFinite(lower) && lower > 0 && price < lower
              ? `O ${PACKAGE_TIER_LABEL[d.tier]} não pode custar menos que o ${PACKAGE_TIER_LABEL[value[i - 1]!.tier]} (${brl(lower)}).`
              : null;
          return (
            <PackageFields
              key={d.tier}
              draft={d}
              minPrice={min}
              floor={floor}
              orderProblem={orderProblem}
              removable={i > 0 && i === value.length - 1}
              onChange={(patch) => set(i, patch)}
              onRemove={() => onChange(value.slice(0, -1))}
            />
          );
        })}
      </div>
      {next && (
        <Button
          type="button"
          variant="mini"
          onClick={() =>
            onChange([
              ...value,
              newDraft(next, { deliveryDays: value[value.length - 1]?.deliveryDays }),
            ])
          }
        >
          <Plus size={14} aria-hidden="true" /> Adicionar o pacote {PACKAGE_TIER_LABEL[next]}
        </Button>
      )}
    </div>
  );
}

function PackageFields({
  draft: d,
  minPrice,
  floor,
  orderProblem,
  removable,
  onChange,
  onRemove,
}: {
  draft: PackageDraft;
  minPrice: number;
  floor: number;
  orderProblem: string | null;
  removable: boolean;
  onChange: (patch: Partial<PackageDraft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const label = PACKAGE_TIER_LABEL[d.tier];
  return (
    <fieldset className="pkg-edit" data-tier={d.tier}>
      <legend>{label}</legend>
      <Field label="Nome do pacote">
        <Input
          value={d.name}
          onChange={(e) => onChange({ name: e.target.value })}
          required
          minLength={3}
          maxLength={PACKAGE_NAME_MAX}
        />
      </Field>
      <Field label="O que entrega (opcional)">
        <textarea
          className="textarea"
          rows={2}
          value={d.description}
          maxLength={PACKAGE_DESCRIPTION_MAX}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>
      <Field label={`Preço (R$) · mínimo ${brl(floor)}`}>
        <Input
          type="number"
          min={minPrice}
          max={99_999_999.99}
          step="0.01"
          inputMode="decimal"
          value={d.price}
          onChange={(e) => onChange({ price: e.target.value })}
          aria-invalid={orderProblem ? true : undefined}
          aria-describedby={orderProblem ? `${id}-order` : undefined}
          required
        />
      </Field>
      {orderProblem && (
        <p id={`${id}-order`} className="error tiny" role="alert">
          {orderProblem}
        </p>
      )}
      <div className="pkg-edit-pair">
        <Field label="Prazo (dias)">
          <Input
            type="number"
            min={1}
            max={PACKAGE_MAX_DELIVERY_DAYS}
            step="1"
            inputMode="numeric"
            value={d.deliveryDays}
            onChange={(e) => onChange({ deliveryDays: e.target.value })}
            required
          />
        </Field>
        <Field label="Revisões incluídas">
          <Select value={d.revisions} onChange={(e) => onChange({ revisions: e.target.value })}>
            {Array.from({ length: PACKAGE_MAX_REVISIONS }, (_, k) => String(k + 1)).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FeaturesInput
        tierLabel={label}
        value={d.features}
        onChange={(features) => onChange({ features })}
      />
      {removable && (
        <Button type="button" variant="ghost" className="mini pkg-remove" onClick={onRemove}>
          <Trash2 size={14} aria-hidden="true" /> Remover o pacote {label}
        </Button>
      )}
    </fieldset>
  );
}

/**
 * Itens inclusos de um pacote: cada item é uma linha com "×" para tirar. Enter ou o botão
 * acrescentam; o leitor de tela ouve o que entrou e o que saiu, e o motivo de um item recusado fica
 * ligado ao campo.
 */
function FeaturesInput({
  tierLabel,
  value,
  onChange,
}: {
  tierLabel: string;
  value: string[];
  onChange: (features: string[]) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  function add(): void {
    const feature = normalizeFeature(text);
    if (!feature) return;
    const why = featureProblem(feature, value);
    if (why) {
      setError(why);
      return;
    }
    onChange([...value, feature]);
    setAnnounce(`Item adicionado ao ${tierLabel}: ${feature}`);
    setText('');
    setError(null);
  }

  function remove(feature: string): void {
    onChange(value.filter((f) => f !== feature));
    setAnnounce(`Item removido do ${tierLabel}: ${feature}`);
    setError(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault(); // Enter acrescenta o item, não envia o formulário
      add();
    }
  }

  return (
    <div className="tags-field pkg-features-field">
      <label htmlFor={id}>Itens inclusos (opcional)</label>
      {value.length > 0 && (
        <ul className="pkg-feature-list" aria-label={`Itens inclusos no ${tierLabel}`}>
          {value.map((feature) => (
            <li key={feature}>
              <span>{feature}</span>
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={`Remover o item ${feature}`}
                title="Remover"
                onClick={() => remove(feature)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pkg-feature-add">
        <input
          ref={inputRef}
          id={id}
          value={text}
          maxLength={200}
          placeholder={
            value.length >= MAX_FEATURES ? 'Limite de itens atingido' : 'ex.: arquivo vetorial'
          }
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        <Button type="button" variant="mini" onClick={add} disabled={!text.trim()}>
          <Plus size={14} aria-hidden="true" /> Adicionar{' '}
          <span className="sr-only">item ao {tierLabel}</span>
        </Button>
      </div>
      <p id={`${id}-hint`} className="muted tiny">
        Enter adiciona · até {MAX_FEATURES} itens de {FEATURE_MIN} a {FEATURE_MAX} caracteres (
        {value.length}/{MAX_FEATURES})
      </p>
      {error && (
        <p id={`${id}-error`} className="error tiny" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
