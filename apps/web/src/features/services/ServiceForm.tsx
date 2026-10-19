import type {
  Category,
  CreateServiceRequest,
  Service,
  ServiceModality,
  ServicePriceType,
} from '@escambo/types';
import { useState, type FormEvent, type ReactNode } from 'react';
import { BusinessForm } from '../../components/BusinessActions';
import { Button, Field, Input, Select } from '../../components/ui';
import { brl } from '../../lib/format';
import { TagsInput } from './TagsInput';

/** Categoria achatada para o <select>: as filhas recuadas com "— " por nível. */
export interface CategoryOption {
  id: number;
  label: string;
}

export function flattenCategories(
  cats: Category[],
  depth = 0,
  acc: CategoryOption[] = [],
): CategoryOption[] {
  for (const c of cats) {
    acc.push({ id: c.id, label: `${'— '.repeat(depth)}${c.name}` });
    if (c.children.length) flattenCategories(c.children, depth + 1, acc);
  }
  return acc;
}

export const PRICE_TYPE_LABEL: Record<ServicePriceType, string> = {
  fixed: 'Preço fixo',
  hourly: 'Por hora',
  negotiable: 'A combinar',
};
const PRICE_TYPES: ServicePriceType[] = ['fixed', 'hourly', 'negotiable'];

/** Modalidade (RF-023) como o formulário mostra. */
export const MODALITY_LABEL: Record<ServiceModality, string> = {
  remote: 'Remoto',
  onsite: 'Presencial',
  both: 'Remoto e presencial',
};
const MODALITIES: ServiceModality[] = ['remote', 'onsite', 'both'];

/** A modalidade do serviço; resposta antiga, sem modality, sai do isRemote. */
export const modalityOf = (s: Pick<Service, 'modality' | 'isRemote'>): ServiceModality =>
  s.modality ?? (s.isRemote ? 'remote' : 'onsite');

/** O serviço inteiro, como o cadastro e a edição (PATCH) aceitam. */
export type ServiceFormBody = Required<CreateServiceRequest>;

/**
 * Cadastro e edição de serviço (RF-022, RF-023 e RF-024): título, categoria, descrição, tipo de
 * preço, preço, prazo de entrega, modalidade e tags. Preço só fica de fora "a combinar"; o mínimo
 * da plataforma vale para o preço fixo (RN-016), como a API confere.
 */
export function ServiceForm({
  heading,
  initial,
  categories,
  minPrice,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  className,
}: {
  heading?: ReactNode;
  /** Na edição, o serviço como está; no cadastro, nada (remoto e preço fixo de partida). */
  initial?: Service;
  categories: CategoryOption[];
  minPrice: number;
  submitLabel: string;
  pending: boolean;
  onSubmit: (body: ServiceFormBody) => Promise<void> | void;
  onCancel?: () => void;
  className?: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? 0);
  const [priceType, setPriceType] = useState<ServicePriceType>(initial?.priceType ?? 'fixed');
  const [price, setPrice] = useState(initial?.price != null ? String(initial.price) : '');
  const [deliveryDays, setDeliveryDays] = useState(
    initial?.deliveryDays != null ? String(initial.deliveryDays) : '',
  );
  const [modality, setModality] = useState<ServiceModality>(
    initial ? modalityOf(initial) : 'remote',
  );
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const effectiveCategory = categoryId || categories[0]?.id || 0;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    await onSubmit({
      categoryId: effectiveCategory,
      title,
      description,
      priceType,
      price: priceType === 'negotiable' ? null : Number(price),
      deliveryDays: deliveryDays === '' ? null : Number(deliveryDays),
      // isRemote junto, para quem ainda lê só ele; a API usa a modality.
      isRemote: modality !== 'onsite',
      modality,
      tags,
    });
  }

  return (
    <BusinessForm className={className} onSubmit={submit}>
      {heading && <h3>{heading}</h3>}
      <Field label="Título">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={3}
          maxLength={150}
        />
      </Field>
      <Field label="Categoria">
        <Select value={effectiveCategory} onChange={(e) => setCategoryId(Number(e.target.value))}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Descrição">
        <textarea
          className="textarea"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          minLength={10}
        />
      </Field>
      {/* Dois campos por linha; em tela estreita, um embaixo do outro. */}
      <div className="radio-row">
        <Field label="Tipo de preço">
          <Select
            value={priceType}
            onChange={(e) => setPriceType(e.target.value as ServicePriceType)}
          >
            {PRICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {PRICE_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {priceType === 'fixed' && (
          <Field label={`Preço (R$) · mínimo ${brl(minPrice)}`}>
            <Input
              type="number"
              min={minPrice}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </Field>
        )}
        {priceType === 'hourly' && (
          <Field label="Preço por hora (R$)">
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </Field>
        )}
        {priceType === 'negotiable' && (
          <p className="muted tiny" data-testid="price-negotiable">
            Sem preço no anúncio: o valor é combinado na proposta.
          </p>
        )}
      </div>
      <div className="radio-row">
        <Field label="Prazo de entrega em dias (opcional)">
          <Input
            type="number"
            min={1}
            step="1"
            value={deliveryDays}
            onChange={(e) => setDeliveryDays(e.target.value)}
          />
        </Field>
        <Field label="Modalidade">
          <Select value={modality} onChange={(e) => setModality(e.target.value as ServiceModality)}>
            {MODALITIES.map((m) => (
              <option key={m} value={m}>
                {MODALITY_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <TagsInput value={tags} onChange={setTags} />
      <div className="svc-actions">
        <Button type="submit" disabled={pending}>
          {pending ? 'Salvando…' : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </BusinessForm>
  );
}
