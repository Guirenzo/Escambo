import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  cancelLabel,
  dropLabel,
  edgeLabel,
  grabbedAt,
  grabLabel,
  GRIP_HINT,
  keyTarget,
  LIST_CHANGED,
  moveLabel,
  moveTo,
  SETTLE_MS,
  stayLabel,
} from './reorder';

/**
 * Pegar e soltar pelo teclado (ADR 53), ao lado do arraste por ponteiro e sem encostar nele.
 *
 * A prévia aqui é a ordem de verdade: em vez de deslocar linhas com `transform`, a lista
 * renderizada passa a ser `moveTo(items, de, para)`. Assim ordem visual, ordem do DOM, ordem de
 * tabulação e o número mostrado na linha nunca divergem, cancelar é jogar fora um estado, e o
 * caminho inteiro se testa sem layout — nada aqui mede a tela.
 *
 * Pegar e soltar acontecem só no `keydown`. No modo de navegação do NVDA e do JAWS as setas não
 * chegam ao elemento com foco, e a ativação vem como clique sintético: se o clique pegasse, o
 * item ficaria preso na mão, as setas não moveriam nada e o espaço seguinte acionaria o que
 * estivesse sob o cursor virtual — que pode ser o botão de remover da linha de baixo. Clique
 * apenas foca a alça e diz onde está o caminho garantido, que são as setas de subir e descer.
 */

/** Fase da pega: `committed` é o intervalo entre soltar e a ordem nova chegar. */
interface Grab {
  id: number;
  to: number;
  committed: boolean;
}

/** Para onde o foco volta depois de um render que mexeu nos nós. */
type Refocus = { kind: 'grip'; id: number } | { kind: 'give-back'; el: HTMLElement };

export function useKeyboardSort<T extends { id: number; title: string }>({
  items,
  listRef,
  listOnScreen,
  blocked,
  rescueRef,
  onCommit,
  onAnnounce,
}: {
  /** A lista gravada (a verdade), nunca a prévia. */
  items: readonly T[];
  /** A lista na tela: para recusar a pega enquanto o ponteiro ainda assenta as linhas. */
  listRef: RefObject<HTMLElement | null>;
  /**
   * A lista está na tela? Vem do cartão, e não de ler a ref no render: a ref só muda no commit
   * que desmonta a lista, e nenhum render novo aconteceria para o efeito perceber.
   */
  listOnScreen: boolean;
  /** Verdadeiro enquanto o ponteiro arrasta: a pega é recusada, em silêncio. */
  blocked: boolean;
  /** Onde o foco se salva quando a linha pega some do documento (o título do cartão). */
  rescueRef: RefObject<HTMLElement | null>;
  /** Grava, uma vez por pega, a ordem inteira de ids. */
  onCommit: (ids: number[]) => void;
  /** Escreve na região viva; as frases vêm prontas de reorder.ts. */
  onAnnounce: (text: string) => void;
}): {
  /** A lista a renderizar: a prévia enquanto há pega, senão a própria `items`. */
  order: readonly T[];
  /** Id do item na mão agora, ou null (já solto, ou nenhum). */
  grabbedId: number | null;
  /** Há pega em qualquer fase: enquanto for true, o arraste e as setas ficam fora. */
  busy: boolean;
  /** Cancela de fora (o ponteiro assumindo); `restore` é para onde devolver o foco. */
  cancel: (restore?: HTMLElement | null, fromPointer?: boolean) => void;
  /** Vai na alça, junto do `handleProps` do arraste. Recebe o item, nunca o índice. */
  handleProps: (item: T) => {
    'data-grab': number;
    'aria-pressed': boolean;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
    onClick: (e: ReactMouseEvent<HTMLElement>) => void;
    onBlur: (e: ReactFocusEvent<HTMLElement>) => void;
  };
} {
  const [grab, setGrab] = useState<Grab | null>(null);
  const at = grab ? grabbedAt(items, grab.id, grab.to) : null;
  const order = grab && at ? moveTo(items, at.from, at.to) : items;

  // Espelhos: os manipuladores são estáveis e não podem enxergar uma lista velha.
  const state = useRef({ items, grab, at, onCommit, onAnnounce });
  useLayoutEffect(() => {
    state.current = { items, grab, at, onCommit, onAnnounce };
  });

  const refocus = useRef<Refocus | null>(null);
  /**
   * Um cancelamento pelo ponteiro acabou de falar: o clique do mesmo gesto não atropela a frase.
   * Só o ponteiro liga isto — Esc e Tab não trazem clique depois, e deixar a marca ligada faria
   * a próxima ativação do leitor de tela engolir a dica.
   */
  const justCancelled = useRef(false);

  const announce = useCallback((text: string) => state.current.onAnnounce(text), []);

  const clear = useCallback((next: Refocus | null): void => {
    refocus.current = next;
    setGrab(null);
  }, []);

  const cancel = useCallback(
    (restore?: HTMLElement | null, fromPointer = false): void => {
      const { grab: g, items: list, at: spot } = state.current;
      if (!g || g.committed) return;
      if (fromPointer) justCancelled.current = true;
      if (spot) {
        const item = list[spot.from];
        if (item) announce(cancelLabel(item.title, spot.from, list.length));
      }
      // Desmontar a prévia mexe nos nós: sem devolver o foco, ele cai no corpo da página.
      clear(restore ? { kind: 'give-back', el: restore } : { kind: 'grip', id: g.id });
    },
    [announce, clear],
  );

  // A pega morre quando a lista não sustenta mais a prévia: item removido em outra aba, lista
  // pequena demais, ou a própria lista fora da tela (a consulta virou erro, por exemplo).
  const gone = grab !== null && (at === null || !listOnScreen);
  useEffect(() => {
    if (!gone) return;
    const committed = grab?.committed ?? false;
    if (!committed) announce(LIST_CHANGED);
    clear(null);
    // Sem nó em que pousar, o foco vai para o título do cartão em vez do topo do documento.
    if (document.activeElement === document.body) {
      rescueRef.current?.focus({ preventScroll: true });
    }
  }, [gone, grab, announce, clear, rescueRef]);

  // Depois de soltar, a prévia fica de pé até a ordem nova chegar (aí `de` e `para` coincidem e
  // nada se mexe na tela). Se a gravação falhar, o mesmo tempo do arraste por ponteiro desfaz.
  const settled = at !== null && at.from === at.to;
  useEffect(() => {
    if (!grab?.committed) return;
    if (settled) {
      clear(null); // a ordem nova chegou: a prévia já é a tela, e nada se mexe
      return;
    }
    // As dependências são valores, não o objeto de posição, que nasce novo a cada render: com
    // ele, qualquer render (digitar no formulário, um toast) adiaria o fim da espera para sempre.
    const timer = window.setTimeout(() => clear(null), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [grab?.id, grab?.committed, settled, clear]);

  // Todo render que mexeu nos nós devolve o foco. Roda sempre e consome o pedido: pedido velho
  // nunca fica preso esperando um render que não vem.
  useLayoutEffect(() => {
    const want = refocus.current;
    refocus.current = null;
    if (!want) return;
    if (want.kind === 'grip') {
      const el = document.querySelector<HTMLElement>(`[data-grab="${want.id}"]`);
      el?.focus({ preventScroll: true });
      el?.closest('li')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Saiu pelo Tab: só devolve se o render roubou o foco de quem tinha acabado de recebê-lo.
    if (want.el.isConnected && document.activeElement === document.body) {
      want.el.focus({ preventScroll: true });
    }
  });

  const startGrab = useCallback(
    (item: T): void => {
      const { grab: g, items: list } = state.current;
      if (g || blocked || list.length < 2) return;
      // Linhas ainda deslocadas são arraste assentando: reordenar o DOM por baixo delas
      // deixaria a tela inconsistente. A recusa é silenciosa e dura um render.
      const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
      if (rows.some((r) => r.style.transform !== '')) return;
      const from = list.findIndex((i) => i.id === item.id);
      if (from < 0) return;
      setGrab({ id: item.id, to: from, committed: false });
      announce(grabLabel(item.title, from, list.length));
    },
    [blocked, listRef, announce],
  );

  const moveTarget = useCallback(
    (target: number): void => {
      const { grab: g, at: spot, items: list } = state.current;
      if (!g || g.committed || !spot) return;
      if (target === spot.to) {
        // Bateu na ponta: nada renderiza, então nada de pedido de foco preso para depois.
        announce(edgeLabel(spot.to, list.length));
        if (g.to !== spot.to) setGrab({ ...g, to: spot.to }); // a lista encolheu por baixo
        return;
      }
      refocus.current = { kind: 'grip', id: g.id };
      setGrab({ ...g, to: target });
      announce(moveLabel(target, list.length));
    },
    [announce],
  );

  const drop = useCallback((): void => {
    const { grab: g, at: spot, items: list } = state.current;
    if (!g || g.committed || !spot) return;
    const item = list[spot.from];
    if (!item) return;
    if (spot.to === spot.from) {
      // Pegou e soltou no lugar: não gasta uma gravação, e diz que não mudou nada.
      announce(stayLabel(item.title, spot.from, list.length));
      clear(null);
      return;
    }
    announce(dropLabel(item.title, spot.to, list.length));
    setGrab({ ...g, committed: true });
    state.current.onCommit(moveTo(list, spot.from, spot.to).map((i) => i.id));
  }, [announce, clear]);

  const grabbedId = grab && !grab.committed ? grab.id : null;

  // `grabbedId` entra nas dependências porque `aria-pressed` é lido no render, e o espelho só é
  // atualizado depois dele: ler do espelho aqui mostraria o estado anterior.
  const handleProps = useCallback(
    (item: T) => ({
      'data-grab': item.id,
      'aria-pressed': grabbedId === item.id,
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>): void => {
        const { grab: g, at: spot, items: list } = state.current;
        const holding = g !== null && !g.committed;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault(); // não rola a página e não gera o clique
          if (e.repeat) return;
          if (holding) drop();
          else startGrab(item);
          return;
        }
        if (!holding || !spot) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
          return;
        }
        const target = keyTarget(spot.to, list.length, e.key);
        if (target === null) return; // Tab e o resto seguem o caminho normal
        e.preventDefault();
        if (e.repeat) return; // tecla segurada inundaria a região viva
        moveTarget(target);
      },
      onClick: (e: ReactMouseEvent<HTMLElement>): void => {
        // O teclado nunca chega aqui (o preventDefault do keydown mata o clique). Sobram o clique
        // de mouse, que precisa ao menos focar a alça para o espaço seguinte funcionar, e a
        // ativação sintética do leitor de tela em modo de navegação.
        e.currentTarget.focus({ preventScroll: true });
        const doPonteiro = e.detail > 0;
        if (doPonteiro || justCancelled.current) {
          // Clique de ponteiro não fala: ele é o fim de um arraste ou de um cancelamento, e a
          // frase daquele gesto acabou de ser escrita. Ativação sintética (detail 0) fala,
          // porque ali o espaço não vai pegar e a pessoa precisa saber para onde ir.
          justCancelled.current = false;
          return;
        }
        state.current.onAnnounce(GRIP_HINT);
      },
      onBlur: (e: ReactFocusEvent<HTMLElement>): void => {
        // Quem recebe o foco vem no próprio evento: entre o blur e o foco seguinte o navegador
        // deixa `activeElement` no corpo da página, e ler de lá diria "ninguém" num Tab comum.
        const next = e.relatedTarget as HTMLElement | null;
        // O foco também sai quando o nosso render move a linha; aí o refoco devolve na sequência.
        // O microtask espera esse desfecho: se a alça voltou a ter o foco, não houve saída.
        void Promise.resolve().then(() => {
          const now = document.activeElement as HTMLElement | null;
          if (now?.dataset?.grab === String(item.id)) return;
          if (!document.hasFocus()) return; // a janela perdeu o foco: a pega espera a volta
          cancel(next ?? (now && now !== document.body ? now : null));
        });
      },
    }),
    [grabbedId, startGrab, drop, moveTarget, cancel],
  );

  return {
    order,
    grabbedId,
    busy: grab !== null,
    cancel,
    handleProps,
  };
}
