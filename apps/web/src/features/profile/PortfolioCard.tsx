import { ChevronDown, ChevronUp, GripVertical, Images, Link2, Plus, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Input, QueryState } from '../../components/ui';
import { usePortfolio, usePortfolioMutation } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { ImageUploadButton } from '../../components/ImageUploadButton';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { moveItem, moveTo, positionLabel } from '../../lib/reorder';
import { useDragSort } from '../../lib/useDragSort';

const MAX_ITEMS = 12;

/**
 * Portfólio do freelancer: trabalhos com imagem e/ou link, que aparecem no perfil público na ordem
 * daqui. As setas mudam a ordem na hora, devolvem o foco ao mesmo botão e anunciam a nova posição
 * (ADR 43); com o ponteiro, dá para arrastar pela alça (ADR 49), e as setas continuam sendo o
 * caminho do teclado e do leitor de tela.
 */
export function PortfolioCard() {
  const toast = useToast();
  const portfolio = usePortfolio();
  const { add, remove, reorder } = usePortfolioMutation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const count = portfolio.data?.length ?? 0;
  const [announce, setAnnounce] = useState('');
  const refocus = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const orderKey = (portfolio.data ?? []).map((i) => i.id).join(',');
  const { dragging, handleProps } = useDragSort({
    listRef,
    orderKey,
    onDrop: (from, to) => {
      const items = portfolio.data ?? [];
      const item = items[from];
      if (!item) return;
      setAnnounce(`${item.title} agora é o ${positionLabel(to, items.length)}.`);
      reorder.mutate(
        moveTo(items, from, to).map((i) => i.id),
        {
          onError: (er) =>
            toast.error(er instanceof Error ? er.message : 'Não foi possível mudar a ordem'),
        },
      );
    },
  });

  // Mudar de lugar tira o item do DOM e o navegador perde o foco: ele volta ao mesmo botão.
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    document.querySelector<HTMLButtonElement>(`[data-move="${key}"]`)?.focus();
  }, [portfolio.data]);

  function move(index: number, step: -1 | 1): void {
    const items = portfolio.data ?? [];
    const item = items[index];
    const target = index + step;
    if (!item || target < 0 || target >= items.length) return;
    refocus.current = `${item.id}:${step < 0 ? 'up' : 'down'}`;
    setAnnounce(`${item.title} agora é o ${positionLabel(target, items.length)}.`);
    reorder.mutate(
      moveItem(items, index, step).map((i) => i.id),
      {
        onError: (er) =>
          toast.error(er instanceof Error ? er.message : 'Não foi possível mudar a ordem'),
      },
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!imageUrl.trim() && !externalUrl.trim()) {
      toast.error('Informe a imagem ou o link do trabalho');
      return;
    }
    try {
      await add.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        imageUrl: imageUrl.trim() || null,
        externalUrl: externalUrl.trim() || null,
      });
      toast.success('Trabalho adicionado ao portfólio.');
      setTitle('');
      setDescription('');
      setImageUrl('');
      setExternalUrl('');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível adicionar');
    }
  }

  async function removeItem(id: number): Promise<void> {
    try {
      await remove.mutateAsync(id);
      toast.success('Trabalho removido.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível remover');
    }
  }

  return (
    <section className="card wide" aria-labelledby="portfolio-title" data-testid="portfolio-card">
      <div className="card-head">
        <h3 id="portfolio-title">
          <Images size={16} /> Portfólio
        </h3>
        <span className="muted tiny">
          {count} de {MAX_ITEMS} · aparece no seu perfil público
        </span>
      </div>
      {count > 1 && (
        <p className="muted tiny">
          O perfil público mostra os trabalhos nesta ordem. Arraste pela alça ou use as setas para
          trazer o mais forte para o começo.
        </p>
      )}
      <p className="sr-only portfolio-announce" aria-live="polite">
        {announce}
      </p>

      <QueryState
        isLoading={portfolio.isLoading}
        error={portfolio.error}
        data={portfolio.data}
        onRetry={() => void portfolio.refetch()}
      >
        {(items) =>
          items.length === 0 ? (
            <p className="muted tiny">
              Mostre o que você já fez: uma imagem ou um link por trabalho. Clientes olham isso
              antes de contratar.
            </p>
          ) : (
            <ul
              ref={listRef}
              className={`portfolio-list${dragging !== null ? ' is-sorting' : ''}`}
              data-testid="portfolio-list"
            >
              {items.map((i, index) => (
                <li
                  key={i.id}
                  data-testid={`portfolio-row-${i.id}`}
                  className={dragging === index ? 'is-dragging' : undefined}
                >
                  {items.length > 1 && (
                    // Só para o ponteiro (mouse, toque, caneta): teclado e leitor de tela usam
                    // as setas, que fazem o mesmo em um toque (WCAG 2.5.7).
                    <span
                      className="portfolio-grip"
                      aria-hidden="true"
                      title="Arraste para mudar a ordem"
                      {...handleProps(index)}
                    >
                      <GripVertical size={16} />
                    </span>
                  )}
                  <span className="portfolio-pos" aria-hidden="true">
                    {index + 1}
                  </span>
                  {i.imageUrl ? (
                    <img src={mediaVariant(i.imageUrl, MEDIA_THUMB.small)} alt="" loading="lazy" />
                  ) : (
                    <span className="portfolio-thumb">
                      <Link2 size={16} />
                    </span>
                  )}
                  <div className="portfolio-text">
                    <strong>{i.title}</strong>
                    {i.description && <span className="muted tiny">{i.description}</span>}
                    {i.externalUrl && (
                      <a
                        href={i.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tiny"
                      >
                        {i.externalUrl}
                      </a>
                    )}
                  </div>
                  {items.length > 1 && (
                    <div className="portfolio-move">
                      <button
                        type="button"
                        className="icon-btn"
                        data-move={`${i.id}:up`}
                        aria-label={`Mover ${i.title} para cima`}
                        aria-disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        data-move={`${i.id}:down`}
                        aria-label={`Mover ${i.title} para baixo`}
                        aria-disabled={index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ChevronDown size={16} />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remover ${i.title}`}
                    disabled={remove.isPending}
                    onClick={() => void removeItem(i.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>

      {count < MAX_ITEMS && (
        <form className="stack" onSubmit={submit} style={{ marginTop: 12 }}>
          <Field label="Título do trabalho">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
              maxLength={150}
              placeholder="Ex.: Site da padaria do bairro"
            />
          </Field>
          <Field label="Descrição (opcional)">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              placeholder="O que foi feito, em uma linha"
            />
          </Field>
          <Field label="Imagem (URL)">
            <div className="loc-row">
              <Input
                type="text"
                inputMode="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                maxLength={512}
                placeholder="https://…/foto-do-trabalho.jpg ou envie do aparelho"
              />
              <ImageUploadButton
                purpose="portfolio"
                label="Enviar imagem"
                testId="portfolio-upload"
                onUploaded={(url) => {
                  setImageUrl(url);
                  toast.success('Imagem enviada.');
                }}
              />
              {imageUrl.trim() && (
                <img
                  className="upload-preview"
                  src={mediaVariant(imageUrl.trim(), MEDIA_THUMB.small)}
                  alt=""
                  loading="lazy"
                />
              )}
            </div>
          </Field>
          <Field label="Link do trabalho (URL)">
            <Input
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              maxLength={512}
              placeholder="https://…"
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={add.isPending}>
            <Plus size={14} /> {add.isPending ? 'Adicionando…' : 'Adicionar ao portfólio'}
          </Button>
        </form>
      )}
    </section>
  );
}
