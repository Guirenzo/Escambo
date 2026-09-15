import { ChevronLeft, ChevronRight, ExternalLink, Flag, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PortfolioItem } from '@escambo/types';
import { responsiveImage, swipeIntent, wrapIndex } from '../lib/gallery';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Work = PortfolioItem & { imageUrl: string };

/**
 * Galeria do portfólio (ADR 40). Abre o trabalho em tela cheia, com título, contador, descrição e
 * link, e navega entre os trabalhos com imagem por botões, setas, Home e End ou deslizando no
 * toque, em círculo. É um diálogo de verdade: foco preso dentro, Esc fecha, a rolagem da página
 * trava e, ao fechar, o foco volta para quem abriu. A imagem vem do tamanho da tela (srcset) sobre
 * a miniatura desfocada, e as vizinhas são pedidas antes, para abrir sem espera.
 */
export function PortfolioGallery({
  items,
  openId,
  onShow,
  onClose,
  onReport,
}: {
  items: PortfolioItem[];
  openId: number;
  onShow: (id: number) => void;
  onClose: () => void;
  onReport?: (item: PortfolioItem) => void;
}) {
  const works = items.filter((i): i is Work => Boolean(i.imageUrl));
  const index = works.findIndex((i) => i.id === openId);
  const current = index >= 0 ? works[index] : undefined;
  const isOpen = current !== undefined;
  const titleId = useId();
  const dialog = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const touch = useRef<{ id: number; x: number; y: number } | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);

  // Ao abrir: foco no fechar e rolagem da página travada. Ao sair: tudo volta, com o foco em quem abriu.
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [isOpen]);

  // Pede antes as imagens vizinhas, na mesma largura que a tela vai escolher.
  const neighborKey = works.length > 1 && index >= 0 ? `${index}:${works.length}` : '';
  useEffect(() => {
    if (!neighborKey) return;
    for (const step of [1, -1]) {
      const neighbor = works[wrapIndex(index + step, works.length)];
      if (!neighbor) continue;
      const source = responsiveImage(neighbor.imageUrl);
      const img = new Image();
      if (source.sizes) img.sizes = source.sizes;
      if (source.srcSet) img.srcset = source.srcSet;
      img.src = source.src;
    }
    // works muda de identidade a cada render; o que importa é a posição e o tamanho da lista.
  }, [neighborKey]);

  if (!current) return null;

  const many = works.length > 1;
  const image = responsiveImage(current.imageUrl);

  function go(step: number): void {
    if (!many) return;
    onShow(works[wrapIndex(index + step, works.length)]!.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'Home' && many) {
      e.preventDefault();
      onShow(works[0]!.id);
    } else if (e.key === 'End' && many) {
      e.preventDefault();
      onShow(works[works.length - 1]!.id);
    } else if (e.key === 'Tab') {
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.pointerType === 'mouse') return;
    touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    const start = touch.current;
    touch.current = null;
    if (!start || start.id !== e.pointerId) return;
    const intent = swipeIntent(e.clientX - start.x, e.clientY - start.y);
    if (intent) go(intent === 'next' ? 1 : -1);
  }

  return createPortal(
    <div
      ref={dialog}
      className="gallery"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <div className="gallery-bar">
        <span className="gallery-count">
          {index + 1} de {works.length}
        </span>
        <h2 id={titleId} className="gallery-title">
          {current.title}
        </h2>
        <div className="gallery-tools">
          {onReport && (
            <button
              type="button"
              className="gallery-btn"
              aria-label={`Denunciar imagem de ${current.title}`}
              title="Denunciar imagem"
              onClick={() => onReport(current)}
            >
              <Flag size={18} />
            </button>
          )}
          <button
            ref={closeButton}
            type="button"
            className="gallery-btn"
            aria-label="Fechar galeria"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </div>

      <div
        className="gallery-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          touch.current = null;
        }}
      >
        {many && (
          <button
            type="button"
            className="gallery-nav prev"
            aria-label="Trabalho anterior"
            onClick={() => go(-1)}
          >
            <ChevronLeft size={28} />
          </button>
        )}
        <figure className="gallery-figure">
          {image.placeholder && loadedId !== current.id && (
            <img
              className="gallery-placeholder"
              src={image.placeholder}
              alt=""
              aria-hidden="true"
            />
          )}
          <img
            key={current.id}
            className={`gallery-image ${loadedId === current.id ? 'loaded' : ''}`}
            src={image.src}
            srcSet={image.srcSet}
            sizes={image.sizes}
            alt={current.title}
            decoding="async"
            draggable={false}
            onLoad={() => setLoadedId(current.id)}
          />
        </figure>
        {many && (
          <button
            type="button"
            className="gallery-nav next"
            aria-label="Próximo trabalho"
            onClick={() => go(1)}
          >
            <ChevronRight size={28} />
          </button>
        )}
      </div>

      {(current.description || current.externalUrl) && (
        <div className="gallery-caption">
          {current.description && <p>{current.description}</p>}
          {current.externalUrl && (
            <a href={current.externalUrl} target="_blank" rel="noopener noreferrer">
              Ver trabalho <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
