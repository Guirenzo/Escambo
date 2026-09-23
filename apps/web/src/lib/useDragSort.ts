import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { clamp, dropIndex, edgeSpeed, SETTLE_MS, shiftFor } from './reorder';

/**
 * Arrastar para ordenar uma lista vertical (ADR 49), com Pointer Events: mouse, toque e caneta
 * pelo mesmo caminho, sem biblioteca. Só a alça começa o arraste, e só depois de o ponteiro andar
 * alguns pixels; a linha segue o ponteiro, presa entre o começo e o fim da lista, e as outras
 * deslizam para abrir o espaço. Soltar numa posição nova chama `onDrop(de, para)`; soltar no
 * lugar, Esc, o sistema cancelar o ponteiro ou a lista sair da tela devolvem tudo ao lugar. Perto
 * da borda da janela a página rola sozinha. Os deslocamentos vão direto no estilo das linhas, sem
 * render por movimento.
 *
 * Teclado e leitor de tela não arrastam: a lista precisa oferecer outro caminho de um toque só
 * (no portfólio, as setas de subir e descer), como pede a WCAG 2.2 (2.5.7).
 */

/** Quanto o ponteiro anda antes de o arraste valer: um toque parado na alça não mexe em nada. */
const THRESHOLD = 4;
/** O tempo de espera da ordem nova mora em reorder.ts: o teclado (ADR 53) usa o mesmo. */

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
  startClientY: number;
  /** O ponteiro já andou além do limiar: só então a linha se mexe e a página rola. */
  moved: boolean;
  /** Bordas da linha arrastada na origem, em coordenadas da página. */
  top: number;
  bottom: number;
  minDelta: number;
  maxDelta: number;
  clientY: number;
  raf: number;
  cleanup: () => void;
}

/** Linha solta à espera da ordem nova, para assentar do ponto em que foi solta. */
interface Settle {
  row: HTMLElement;
  rows: HTMLElement[];
  top: number;
  timer: number;
}

/**
 * A linha solta (ou a que volta) fica por cima das vizinhas até terminar de deslizar; sem isso,
 * ela passaria por baixo de quem vem depois dela no documento.
 */
function lift(row: HTMLElement): void {
  row.style.zIndex = '2';
}
function releaseAfterSlide(row: HTMLElement): void {
  const done = (): void => {
    row.style.zIndex = '';
  };
  row.addEventListener('transitionend', done, { once: true });
  window.setTimeout(done, 400); // sem transição (movimento reduzido), o transitionend pode não vir
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
  const settle = useRef<Settle | null>(null);
  const lastKey = useRef(orderKey);
  const dropRef = useRef(onDrop);
  useLayoutEffect(() => {
    dropRef.current = onDrop;
  });

  const clearSettle = useCallback((): Settle | null => {
    const pending = settle.current;
    settle.current = null;
    if (pending) window.clearTimeout(pending.timer);
    return pending;
  }, []);

  const finish = useCallback((commit: boolean): void => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.cleanup();
    cancelAnimationFrame(s.raf);
    setDragging(null);
    const row = s.rows[s.from];
    if (!row) return;
    lift(row);
    if (commit && s.moved && row.isConnected && s.to !== s.from) {
      // As linhas ficam onde estão até a nova ordem chegar; aí a arrastada assenta no lugar.
      const pending: Settle = {
        row,
        rows: s.rows,
        top: row.getBoundingClientRect().top,
        timer: 0,
      };
      pending.timer = window.setTimeout(() => {
        // A ordem não chegou (a lista nem mudou): tudo volta ao lugar, deslizando.
        if (settle.current !== pending) return;
        settle.current = null;
        for (const r of pending.rows) r.style.transform = '';
        releaseAfterSlide(row);
      }, SETTLE_MS);
      settle.current = pending;
      dropRef.current(s.from, s.to);
    } else {
      for (const r of s.rows) r.style.transform = '';
      releaseAfterSlide(row);
    }
  }, []);

  // Roda a cada render. A linha solta assenta quando a ordem nova já está na tela (a chave mudou),
  // sem depender de quando nem se a gravação chega: se o nó saiu do documento, a espera é
  // descartada; se a ordem nunca chegar, o tempo limite devolve as linhas ao lugar.
  useLayoutEffect(() => {
    const changed = lastKey.current !== orderKey;
    lastKey.current = orderKey;
    if (settle.current && !settle.current.row.isConnected) clearSettle();
    if (!changed) return;
    if (session.current) finish(false);
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.children) as HTMLElement[];
    const pending = clearSettle();
    const dropped = pending && rows.includes(pending.row) ? pending.row : null;
    // As outras linhas já estão onde a ordem nova as põe: os deslocamentos saem sem animar.
    for (const r of rows) {
      r.style.transition = 'none';
      r.style.transform = '';
    }
    if (dropped && pending) {
      dropped.style.transform = `translateY(${pending.top - dropped.getBoundingClientRect().top}px)`;
    }
    void list.offsetHeight; // aplica o ponto de partida antes de ligar a transição
    for (const r of rows) r.style.transition = '';
    if (dropped) {
      dropped.style.transform = '';
      releaseAfterSlide(dropped);
    }
  });

  // Saiu da tela no meio do arraste: solta os ouvintes sem mexer na lista.
  useEffect(
    () => () => {
      clearSettle();
      const s = session.current;
      if (!s) return;
      session.current = null;
      s.cleanup();
      cancelAnimationFrame(s.raf);
    },
    [clearSettle],
  );

  const start = useCallback(
    (index: number, e: ReactPointerEvent<HTMLElement>): void => {
      // Um arraste por vez, e nenhum enquanto a linha anterior espera a ordem nova.
      if (session.current || settle.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(list.children) as HTMLElement[];
      if (rows.length < 2 || !rows[index]) return;
      e.preventDefault(); // sem seleção de texto nem arraste nativo de imagem
      // Linhas ainda deslizando (Esc ou soltura de agora há pouco) assentam antes da medida:
      // medir com o deslocamento no meio levaria a um destino errado.
      for (const r of rows) {
        r.style.transition = 'none';
        r.style.transform = '';
        r.style.zIndex = '';
      }
      const rects = rows.map((r) => r.getBoundingClientRect());
      for (const r of rows) r.style.transition = '';
      const row = rects[index]!;
      const first = rects[0]!;
      const last = rects[rects.length - 1]!;
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
        startClientY: e.clientY,
        moved: false,
        top: row.top + scroll,
        bottom: row.bottom + scroll,
        minDelta: first.top - row.top,
        maxDelta: last.bottom - row.bottom,
        clientY: e.clientY,
        raf: 0,
        cleanup: () => undefined,
      };

      const update = (): void => {
        if (!s.moved) return;
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
        // A lista saiu da tela (ex.: virou a tela de erro): o arraste acaba sem gravar.
        if (!rows[s.from]?.isConnected) {
          finish(false);
          return;
        }
        const speed = s.moved ? edgeSpeed(s.clientY, window.innerHeight) : 0;
        if (speed !== 0) {
          window.scrollBy(0, speed);
          update();
        }
        s.raf = requestAnimationFrame(tick);
      };
      // Os ouvintes ficam na janela, filtrados pelo ponteiro: continuam valendo mesmo que a alça
      // saia do documento ou perca a captura.
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== s.pointerId) return;
        s.clientY = ev.clientY;
        if (!s.moved && Math.abs(ev.clientY - s.startClientY) < THRESHOLD) return;
        s.moved = true;
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

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
      window.addEventListener('scroll', update, { passive: true });
      document.body.classList.add('is-dragging-list');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // ponteiro já solto: o pointerup que vem em seguida encerra
      }
      s.cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('scroll', update);
        document.body.classList.remove('is-dragging-list');
        if (handle.isConnected && handle.hasPointerCapture(s.pointerId)) {
          handle.releasePointerCapture(s.pointerId);
        }
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
