import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { clamp, dropIndex, edgeSpeed, shiftFor } from './reorder';

/**
 * Arrastar para ordenar uma lista vertical (ADR 49), com Pointer Events: mouse, toque e caneta
 * pelo mesmo caminho, sem biblioteca. Só a alça começa o arraste; a linha segue o ponteiro, presa
 * entre o começo e o fim da lista, e as outras deslizam para abrir o espaço. Soltar chama
 * `onDrop(de, para)`; Esc, ou o sistema cancelar o ponteiro, devolve tudo ao lugar. Perto da borda
 * da janela a página rola sozinha. Os deslocamentos vão direto no estilo das linhas, sem render
 * por movimento.
 *
 * Teclado e leitor de tela não arrastam: a lista precisa oferecer outro caminho de um toque só
 * (no portfólio, as setas de subir e descer), como pede a WCAG 2.2 (2.5.7).
 */

interface Session {
  pointerId: number;
  rows: HTMLElement[];
  from: number;
  to: number;
  /** Meio de cada linha na posição de origem, em coordenadas da página. */
  mids: number[];
  /** Quanto as outras linhas deslizam: a altura da arrastada mais o espaço entre linhas. */
  step: number;
  startY: number;
  /** Bordas da linha arrastada na origem, em coordenadas da página. */
  top: number;
  bottom: number;
  minDelta: number;
  maxDelta: number;
  clientY: number;
  raf: number;
  cleanup: () => void;
}

export function useDragSort({
  listRef,
  orderKey,
  onDrop,
}: {
  listRef: RefObject<HTMLElement | null>;
  /** Muda quando a ordem muda (ex.: os ids juntos): é quando a linha solta assenta no lugar. */
  orderKey: string;
  onDrop: (from: number, to: number) => void;
}): {
  dragging: number | null;
  handleProps: (index: number) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  };
} {
  const [dragging, setDragging] = useState<number | null>(null);
  const session = useRef<Session | null>(null);
  const settle = useRef<{ row: HTMLElement; top: number } | null>(null);
  const dropRef = useRef(onDrop);
  useLayoutEffect(() => {
    dropRef.current = onDrop;
  });

  const finish = useCallback((commit: boolean): void => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.cleanup();
    cancelAnimationFrame(s.raf);
    setDragging(null);
    const row = s.rows[s.from];
    if (commit && row && s.to !== s.from) {
      // As linhas ficam onde estão até a nova ordem chegar; aí a arrastada assenta no lugar.
      settle.current = { row, top: row.getBoundingClientRect().top };
      dropRef.current(s.from, s.to);
    } else {
      for (const r of s.rows) r.style.transform = '';
    }
  }, []);

  // A nova ordem chegou (ou a lista mudou por fora): os deslocamentos saem sem animar, porque as
  // linhas já estão onde a ordem nova as põe, e a arrastada desliza do ponto em que foi solta.
  useLayoutEffect(() => {
    if (session.current) finish(false);
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.children) as HTMLElement[];
    const s = settle.current;
    settle.current = null;
    for (const r of rows) {
      r.style.transition = 'none';
      r.style.transform = '';
    }
    const dropped = s && rows.includes(s.row) ? s.row : null;
    if (dropped && s) {
      dropped.style.transform = `translateY(${s.top - dropped.getBoundingClientRect().top}px)`;
    }
    void list.offsetHeight; // aplica o ponto de partida antes de ligar a transição
    for (const r of rows) r.style.transition = '';
    if (dropped) dropped.style.transform = '';
  }, [orderKey, listRef, finish]);

  // Saiu da tela no meio do arraste: solta os ouvintes sem mexer na lista.
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      s.cleanup();
      cancelAnimationFrame(s.raf);
    },
    [],
  );

  const start = useCallback(
    (index: number, e: ReactPointerEvent<HTMLElement>): void => {
      if (session.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(list.children) as HTMLElement[];
      const rects = rows.map((r) => r.getBoundingClientRect());
      const row = rects[index];
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (rows.length < 2 || !row || !first || !last) return;
      e.preventDefault(); // sem seleção de texto nem arraste nativo de imagem
      const handle = e.currentTarget;
      const scroll = window.scrollY;
      const s: Session = {
        pointerId: e.pointerId,
        rows,
        from: index,
        to: index,
        mids: rects.map((r) => r.top + scroll + r.height / 2),
        step: row.height + (parseFloat(getComputedStyle(list).rowGap) || 0),
        startY: e.clientY + scroll,
        top: row.top + scroll,
        bottom: row.bottom + scroll,
        minDelta: first.top - row.top,
        maxDelta: last.bottom - row.bottom,
        clientY: e.clientY,
        raf: 0,
        cleanup: () => undefined,
      };

      const update = (): void => {
        const delta = clamp(s.clientY + window.scrollY - s.startY, s.minDelta, s.maxDelta);
        const dragged = rows[s.from];
        if (dragged) dragged.style.transform = `translateY(${delta}px)`;
        const to = dropIndex(s.mids, s.from, s.top + delta, s.bottom + delta);
        if (to === s.to) return;
        s.to = to;
        rows.forEach((r, i) => {
          if (i !== s.from) r.style.transform = `translateY(${shiftFor(i, s.from, to, s.step)}px)`;
        });
      };
      const tick = (): void => {
        const speed = edgeSpeed(s.clientY, window.innerHeight);
        if (speed !== 0) {
          window.scrollBy(0, speed);
          update();
        }
        s.raf = requestAnimationFrame(tick);
      };
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== s.pointerId) return;
        s.clientY = ev.clientY;
        update();
      };
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId === s.pointerId) finish(true);
      };
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId === s.pointerId) finish(false);
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        finish(false);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
      window.addEventListener('scroll', update, { passive: true });
      document.body.classList.add('is-dragging-list');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // ponteiro já solto: o pointerup que vem em seguida encerra
      }
      s.cleanup = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('scroll', update);
        document.body.classList.remove('is-dragging-list');
        if (handle.hasPointerCapture(s.pointerId)) handle.releasePointerCapture(s.pointerId);
      };
      session.current = s;
      s.raf = requestAnimationFrame(tick);
      setDragging(index);
    },
    [listRef, finish],
  );

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(index, e),
    }),
    [start],
  );

  return { dragging, handleProps };
}
