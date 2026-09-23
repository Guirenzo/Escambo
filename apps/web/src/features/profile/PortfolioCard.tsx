import { ChevronDown, ChevronUp, GripVertical, Images, Link2, Plus, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Input, QueryState } from '../../components/ui';
import { usePortfolio, usePortfolioMutation } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { ImageUploadButton } from '../../components/ImageUploadButton';
import { MEDIA_THUMB, mediaVariant } from '../../lib/image';
import { dropLabel, moveItem, moveTo } from '../../lib/reorder';
import { useDragSort } from '../../lib/useDragSort';
import { useKeyboardSort } from '../../lib/useKeyboardSort';

const MAX_ITEMS = 12;

/**
 * Portfólio do freelancer: trabalhos com imagem e/ou link, que aparecem no perfil público na ordem
 * daqui. Três caminhos para a mesma ordem: as setas mudam de uma vez, devolvem o foco ao mesmo
 * botão e anunciam a nova posição (ADR 43); o ponteiro arrasta pela alça (ADR 49); e a alça
 * também pega pelo teclado, move sem gravar e grava uma vez ao soltar (ADR 53). As setas seguem
 * sendo a alternativa de um toque que a norma exige e o caminho garantido no leitor de tela.
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  const items = portfolio.data ?? [];
  const orderKey = items.map((i) => i.id).join(',');
  const saveOrder = (ids: number[]): void => {
    reorder.mutate(ids, {
      onError: (er) =>
        toast.error(er instanceof Error ? er.message : 'Não foi possível mudar a ordem'),
    });
  };
  const { dragging, handleProps } = useDragSort({
    listRef,
    orderKey,
    onDrop: (from, to) => {
      const item = items[from];
      if (!item) return;
      setAnnounce(dropLabel(item.title, to, items.length));
      saveOrder(moveTo(items, from, to).map((i) => i.id));
    },
  });
  // Pegar e soltar pelo teclado (ADR 53): enquanto há pega, a lista mostrada é a prévia.
  const {
    order,
    grabbedId,
    busy,
    cancel: cancelGrab,
    handleProps: gripProps,
  } = useKeyboardSort({
    items,
    listRef,
    // A lista some da tela quando a consulta vira erro: aí a pega é abandonada na hora.
    listOnScreen: !portfolio.error && items.length > 1,
    blocked: dragging !== null,
    rescueRef: titleRef,
    onCommit: saveOrder,
    onAnnounce: setAnnounce,
  });

  // Mudar de lugar tira o item do DOM e o navegador perde o foco: ele volta ao mesmo botão.
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    const el = document.querySelector<HTMLButtonElement>(`[data-move="${key}"]`);
    el?.focus({ preventScroll: true });
    el?.closest('li')?.scrollIntoView({ block: 'nearest' });
  }, [portfolio.data]);

  // Pelo id, e não pelo índice: durante uma prévia do teclado o índice da tela é o da prévia.
  function move(id: number, step: -1 | 1): void {
    const index = items.findIndex((i) => i.id === id);
    const item = items[index];
    const target = index + step;
    if (!item || target < 0 || target >= items.length) return;
    refocus.current = `${item.id}:${step < 0 ? 'up' : 'down'}`;
    setAnnounce(dropLabel(item.title, target, items.length));
    saveOrder(moveItem(items, index, step).map((i) => i.id));
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
        <h3 id="portfolio-title" ref={titleRef} tabIndex={-1}>
          <Images size={16} /> Portfólio
        </h3>
        <span className="muted tiny">
          {count} de {MAX_ITEMS} · aparece no seu perfil público
        </span>
      </div>
      {count > 1 && (
        <p className="muted tiny">
          O perfil público mostra os trabalhos nesta ordem. Arraste pela alça ou use as setas para
          trazer o mais forte para o começo.{' '}
          <span id="portfolio-ordem-dica">
            Na alça: espaço pega, setas movem, espaço solta, Esc ou Tab cancela.
          </span>
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
            <ul ref={listRef} className="portfolio-list" data-testid="portfolio-list">
              {order.map((i, index) => (
                <li
                  key={i.id}
                  data-testid={`portfolio-row-${i.id}`}
                  className={
                    grabbedId === i.id
                      ? 'is-grabbed'
                      : dragging === index
                        ? 'is-dragging'
                        : undefined
                  }
                >
                  {order.length > 1 && (
                    <button
                      type="button"
                      className="icon-btn portfolio-grip"
                      aria-label={`Reordenar ${i.title}`}
                      // A dica sai enquanto o item está na mão: a frase de pegar já disse as
                      // teclas, e ela seria relida a cada seta.
                      aria-describedby={grabbedId === i.id ? undefined : 'portfolio-ordem-dica'}
                      {...gripProps(i)}
                      onPointerDown={(e) => {
                        // Com a prévia na tela, um arraste mediria a lista errada: o ponteiro
                        // cancela a pega e não arrasta; o gesto seguinte arrasta.
                        if (busy) {
                          cancelGrab(e.currentTarget, true);
                          return;
                        }
                        handleProps(index).onPointerDown(e);
                      }}
                    >
                      <GripVertical size={16} />
                    </button>
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
                  {order.length > 1 && (
                    <div className="portfolio-move">
                      {/* As setas leem a ordem gravada, não a prévia; durante uma pega elas saem
                          de cena, porque mudariam a ordem por baixo do que está na tela. */}
                      <button
                        type="button"
                        className="icon-btn"
                        data-move={`${i.id}:up`}
                        aria-label={`Mover ${i.title} para cima`}
                        aria-disabled={items.indexOf(i) === 0}
                        disabled={busy}
                        onClick={() => move(i.id, -1)}
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        data-move={`${i.id}:down`}
                        aria-label={`Mover ${i.title} para baixo`}
                        aria-disabled={items.indexOf(i) === items.length - 1}
                        disabled={busy}
                        onClick={() => move(i.id, 1)}
                      >
                        <ChevronDown size={16} />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remover ${i.title}`}
                    disabled={remove.isPending || busy}
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
