import { ChevronLeft, ChevronRight, ExternalLink, Flag, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { PortfolioItem } from '@escambo/types';
import {
  containedSize,
  isZoomed,
  NO_ZOOM,
  panZoom,
  pinchZoom,
  responsiveImage,
  swipeIntent,
  wheelScale,
  wrapIndex,
  ZOOM_DOUBLE,
  ZOOM_MAX,
  ZOOM_STEP,
  zoomAt,
  zoomedSizes,
  type Point,
  type Size,
  type Zoom,
} from '../lib/gallery';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Quanto cada seta do teclado desloca a imagem ampliada. */
const KEY_PAN = 80;
/** Toque que andou menos que isso ainda é toque (para o duplo toque), não arrasto. */
const TAP_MOVE = 10;
/** Dois toques dentro desse tempo e dessa distância são um duplo toque. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 40;

type Work = PortfolioItem & { imageUrl: string };

type Gesture =
  | { kind: 'pan'; id: number; start: Point; zoom: Zoom; moved: boolean }
  | { kind: 'pinch'; zoom: Zoom; distance: number; center: Point };

interface Frame {
  box: Size;
  content: Size;
  center: Point;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Galeria do portfólio (ADR 40 e 43). Abre o trabalho em tela cheia, com título, contador,
 * descrição e link, e navega entre os trabalhos com imagem por botões, setas, Home e End ou
 * deslizando no toque, em círculo. É um diálogo de verdade: foco preso dentro, Esc fecha, a rolagem
 * da página trava e, ao fechar, o foco volta para quem abriu. A imagem vem do tamanho da tela
 * (srcset) sobre a miniatura desfocada, e as vizinhas são pedidas antes.
 *
 * Zoom (ADR 43): pinça e duplo toque no celular; roda, duplo clique, botões e as teclas +, - e 0 no
 * computador. O ponto sob os dedos ou o cursor fica parado enquanto a escala muda. Ampliada, arrastar
 * e as setas deslocam a imagem em vez de trocar de trabalho, e o `sizes` acompanha a largura
 * ampliada para o navegador buscar a versão maior. Trocar de trabalho volta ao tamanho inteiro.
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
  const stage = useRef<HTMLDivElement | null>(null);
  const figure = useRef<HTMLElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const downOnBackground = useRef(false);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const lastPointerType = useRef('mouse');
  const [loadedId, setLoadedId] = useState<number | null>(null);
  // O zoom é do trabalho aberto: ao trocar de trabalho, volta sozinho ao inteiro.
  const [view, setView] = useState<{ id: number; zoom: Zoom; sizes: string; smooth: boolean }>({
    id: openId,
    zoom: NO_ZOOM,
    sizes: '',
    smooth: false,
  });
  const onCurrent = current !== undefined && view.id === current.id;
  const zoom = onCurrent ? view.zoom : NO_ZOOM;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

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

  // Ctrl + roda (e a pinça do touchpad) ampliaria a página inteira; dentro da galeria, amplia a imagem.
  useEffect(() => {
    const el = stage.current;
    if (!isOpen || !el) return;
    const block = (e: globalThis.WheelEvent): void => {
      if (e.ctrlKey) e.preventDefault();
    };
    el.addEventListener('wheel', block, { passive: false });
    return () => el.removeEventListener('wheel', block);
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
  const zoomed = isZoomed(zoom);
  const percent = Math.round(zoom.scale * 100);

  /** Moldura da imagem: tamanho, tamanho desenhado (contain) e centro na tela. */
  function frame(): Frame | null {
    const el = figure.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const box = { width: rect.width, height: rect.height };
    const img = picture.current;
    const natural =
      img && img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : box;
    return {
      box,
      content: containedSize(natural, box),
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
  }

  const local = (f: Frame, clientX: number, clientY: number): Point => ({
    x: clientX - f.center.x,
    y: clientY - f.center.y,
  });

  function applyZoom(next: Zoom, f: Frame, smooth: boolean): void {
    const id = current!.id;
    setView({
      id,
      zoom: next,
      smooth,
      sizes: isZoomed(next) ? zoomedSizes(f.content, next.scale) : '',
    });
  }

  function zoomTo(scale: number, point: Point = { x: 0, y: 0 }): void {
    const f = frame();
    if (f) applyZoom(zoomAt(zoom, scale, point, f.content, f.box), f, true);
  }

  function resetZoom(): void {
    setView({ id: current!.id, zoom: NO_ZOOM, sizes: '', smooth: true });
  }

  function toggleZoom(point: Point): void {
    if (isZoomed(zoomRef.current)) resetZoom();
    else zoomTo(ZOOM_DOUBLE, point);
  }

  function pan(dx: number, dy: number): void {
    const f = frame();
    if (f) applyZoom(panZoom(zoom, dx, dy, f.content, f.box), f, true);
  }

  function go(step: number): void {
    if (!many) return;
    onShow(works[wrapIndex(index + step, works.length)]!.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      // Ampliada, a seta mostra o lado para onde aponta; inteira, troca de trabalho.
      if (zoomed) pan(-dir * KEY_PAN, 0);
      else go(dir);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && zoomed) {
      e.preventDefault();
      pan(0, e.key === 'ArrowDown' ? -KEY_PAN : KEY_PAN);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomTo(zoom.scale * ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      zoomTo(zoom.scale / ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      resetZoom();
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
    downOnBackground.current = e.target === e.currentTarget;
    lastPointerType.current = e.pointerType;
    // Os botões da faixa (anterior, próximo, zoom) cuidam do próprio clique.
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const f = frame();
    if (!f) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    moved.current = false;
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const [a, b] = points as [Point, Point];
      gesture.current = {
        kind: 'pinch',
        zoom: zoomRef.current,
        distance: distance(a, b),
        center: local(f, (a.x + b.x) / 2, (a.y + b.y) / 2),
      };
    } else if (points.length === 1) {
      gesture.current = {
        kind: 'pan',
        id: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        zoom: zoomRef.current,
        moved: false,
      };
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const f = frame();
    if (!g || !f) return;
    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      moved.current = true;
      const now = { distance: distance(a, b), center: local(f, (a.x + b.x) / 2, (a.y + b.y) / 2) };
      applyZoom(pinchZoom(g, now, f.content, f.box), f, false);
    } else if (g.id === e.pointerId) {
      const dx = e.clientX - g.start.x;
      const dy = e.clientY - g.start.y;
      if (Math.hypot(dx, dy) > TAP_MOVE) {
        g.moved = true;
        moved.current = true;
      }
      if (isZoomed(g.zoom)) applyZoom(panZoom(g.zoom, dx, dy, f.content, f.box), f, false);
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    const end = pointers.current.get(e.pointerId);
    if (!end) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // Sobrou um dedo: continua arrastando dali, sem virar deslize nem toque.
      const rest = [...pointers.current.entries()][0];
      gesture.current = rest
        ? { kind: 'pan', id: rest[0], start: rest[1], zoom: zoomRef.current, moved: true }
        : null;
      return;
    }
    gesture.current = null;
    if (!g || g.id !== e.pointerId) return;
    if (g.moved) {
      if (!isZoomed(g.zoom) && e.pointerType !== 'mouse') {
        const intent = swipeIntent(e.clientX - g.start.x, e.clientY - g.start.y);
        if (intent) go(intent === 'next' ? 1 : -1);
      }
      return;
    }
    // Toque parado: dois seguidos, perto um do outro, ampliam ou voltam ao inteiro. O mouse usa o
    // duplo clique.
    if (e.pointerType === 'mouse') return;
    const f = frame();
    if (!f) return;
    const point = local(f, e.clientX, e.clientY);
    const last = lastTap.current;
    if (
      last &&
      e.timeStamp - last.at < DOUBLE_TAP_MS &&
      distance(point, last.point) < DOUBLE_TAP_DISTANCE
    ) {
      lastTap.current = null;
      toggleZoom(point);
    } else {
      lastTap.current = { at: e.timeStamp, point };
    }
  }

  function onPointerCancel(e: PointerEvent<HTMLDivElement>): void {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLDivElement>): void {
    if (lastPointerType.current !== 'mouse' || (e.target as HTMLElement).closest('button')) return;
    const f = frame();
    if (f) toggleZoom(local(f, e.clientX, e.clientY));
  }

  function onWheel(e: ReactWheelEvent<HTMLDivElement>): void {
    if (e.deltaY === 0) return;
    const f = frame();
    if (!f) return;
    const point = local(f, e.clientX, e.clientY);
    applyZoom(zoomAt(zoom, wheelScale(zoom.scale, e.deltaY), point, f.content, f.box), f, false);
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
        ref={stage}
        className="gallery-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget && downOnBackground.current && !moved.current) {
            onClose();
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
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
        <figure ref={figure} className={`gallery-figure${zoomed ? ' zoomed' : ''}`}>
          <div
            className={`gallery-canvas${onCurrent && view.smooth ? ' smooth' : ''}`}
            style={{ transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }}
          >
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
              ref={picture}
              className={`gallery-image ${loadedId === current.id ? 'loaded' : ''}`}
              src={image.src}
              srcSet={image.srcSet}
              sizes={onCurrent && view.sizes ? view.sizes : image.sizes}
              alt={current.title}
              decoding="async"
              draggable={false}
              onLoad={() => setLoadedId(current.id)}
            />
          </div>
        </figure>
        <div className="gallery-zoom" role="group" aria-label="Zoom da imagem">
          <button
            type="button"
            className="gallery-btn"
            aria-label="Reduzir imagem"
            aria-disabled={!zoomed}
            onClick={() => zoomTo(zoom.scale / ZOOM_STEP)}
          >
            <ZoomOut size={18} />
          </button>
          <button
            type="button"
            className="gallery-zoom-level"
            aria-label={
              zoomed ? `Voltar ao tamanho inteiro (${percent}%)` : 'Tamanho inteiro (100%)'
            }
            aria-disabled={!zoomed}
            onClick={resetZoom}
          >
            {percent}%
          </button>
          <button
            type="button"
            className="gallery-btn"
            aria-label="Ampliar imagem"
            aria-disabled={zoom.scale >= ZOOM_MAX}
            onClick={() => zoomTo(zoom.scale * ZOOM_STEP)}
          >
            <ZoomIn size={18} />
          </button>
        </div>
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
