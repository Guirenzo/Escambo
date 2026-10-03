import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS } from './reorder';
import { useDragSort } from './useDragSort';

/**
 * Arrastar para ordenar (ADR 49) numa lista de mentira com medidas conhecidas: cada linha tem
 * 40 px de altura e 10 px de espaço, então a linha `i` vai de `i * 50` a `i * 50 + 40` e o passo
 * das vizinhas é 50. O jsdom não faz layout nem captura de ponteiro; os dois são simulados aqui.
 */

const ROW = 40;
const GAP = 10;
const STEP = ROW + GAP;

function SortableList({
  items,
  onDrop,
  visible = true,
}: {
  items: string[];
  onDrop: (from: number, to: number) => void;
  visible?: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const { dragging, handleProps } = useDragSort({ listRef, orderKey: items.join(','), onDrop });
  return (
    <div>
      <output>
        {dragging === null ? 'Nada sendo arrastado' : `Arrastando ${items[dragging] ?? '?'}`}
      </output>
      {visible && (
        <ul ref={listRef} style={{ rowGap: `${GAP}px` }}>
          {items.map((title, index) => (
            <li key={title}>
              <button type="button" aria-label={`Arrastar ${title}`} {...handleProps(index)} />
              <span>{title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const handle = (title: string) => screen.getByRole('button', { name: `Arrastar ${title}` });
const row = (title: string) => handle(title).parentElement as HTMLLIElement;
const transforms = () => screen.getAllByRole('listitem').map((li) => li.style.transform);
const status = () => screen.getByRole('status').textContent;

/** Onde a linha está na tela: posição na lista mais o deslocamento que o arraste aplicou. */
function rectOf(el: HTMLElement): DOMRect {
  const index = Array.from(el.parentElement?.children ?? []).indexOf(el);
  const shift = Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);
  const top = index * STEP + shift - window.scrollY;
  return {
    top,
    bottom: top + ROW,
    height: ROW,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/** Meio da linha `index`, onde o ponteiro pega a alça. */
const middle = (index: number) => index * STEP + ROW / 2;

function press(title: string, index: number, init: PointerEventInit = {}) {
  return fireEvent.pointerDown(handle(title), {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientY: middle(index),
    ...init,
  });
}
const moveTo = (clientY: number, pointerId = 1) =>
  fireEvent.pointerMove(window, { pointerId, clientY });
const release = (pointerId = 1) => fireEvent.pointerUp(window, { pointerId });

const captured = new Map<Element, Set<number>>();
type Capture = Pick<
  HTMLElement,
  'setPointerCapture' | 'hasPointerCapture' | 'releasePointerCapture'
>;
const proto = HTMLElement.prototype as Capture;
let scrollBy: ReturnType<typeof vi.fn>;

function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectOf(this);
  });
  captured.clear();
  proto.setPointerCapture = function (this: Element, id: number) {
    captured.set(this, (captured.get(this) ?? new Set()).add(id));
  };
  proto.hasPointerCapture = function (this: Element, id: number) {
    return captured.get(this)?.has(id) ?? false;
  };
  proto.releasePointerCapture = function (this: Element, id: number) {
    captured.get(this)?.delete(id);
  };
  scrollBy = vi.fn();
  vi.stubGlobal('scrollBy', scrollBy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setScrollY(0);
  const leftover = proto as Partial<Capture>;
  delete leftover.setPointerCapture;
  delete leftover.hasPointerCapture;
  delete leftover.releasePointerCapture;
});

const LIST = ['Logo', 'Site', 'Vitrine', 'Cardápio'];

describe('arrastar uma linha para outra posição', () => {
  it('descendo: a linha segue o ponteiro, a vizinha abre espaço e soltar grava de → para', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    // preventDefault no pointerdown: sem seleção de texto nem arraste nativo.
    expect(press('Logo', 0)).toBe(false);
    expect(status()).toBe('Arrastando Logo');
    expect(handle('Logo').hasPointerCapture(1)).toBe(true);

    moveTo(75); // 55 px abaixo: a borda de baixo (95) passou do meio de "Site" (70)
    expect(transforms()).toEqual([
      'translateY(55px)',
      `translateY(-${STEP}px)`,
      'translateY(0px)',
      'translateY(0px)',
    ]);
    expect(onDrop).not.toHaveBeenCalled();

    release();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(0, 1);
    expect(status()).toBe('Nada sendo arrastado');
    expect(handle('Logo').hasPointerCapture(1)).toBe(false);
  });

  it('subindo: as linhas entre o destino e a origem descem um passo', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    press('Cardápio', 3);
    moveTo(60); // 110 px acima: a borda de cima (40) passou do meio de "Site" (70), não do de "Logo" (20)
    expect(transforms()).toEqual([
      'translateY(0px)',
      `translateY(${STEP}px)`,
      `translateY(${STEP}px)`,
      'translateY(-110px)',
    ]);

    release();
    expect(onDrop).toHaveBeenCalledWith(3, 1);
  });

  it('o arraste fica preso entre o começo e o fim da lista, e as pontas são alcançáveis', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    press('Logo', 0);
    moveTo(5000);
    // Fim da lista: 150 px (a última linha termina em 190 e a arrastada em 40).
    expect(row('Logo').style.transform).toBe('translateY(150px)');
    release();
    expect(onDrop).toHaveBeenLastCalledWith(0, 3);
  });

  it('subindo além do topo, a linha para no começo da lista e vira a primeira', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    press('Cardápio', 3);
    moveTo(-5000);
    // Começo da lista: -150 px (a arrastada começa em 150 e a primeira linha em 0).
    expect(transforms()).toEqual([
      `translateY(${STEP}px)`,
      `translateY(${STEP}px)`,
      `translateY(${STEP}px)`,
      'translateY(-150px)',
    ]);
    release();
    expect(onDrop).toHaveBeenCalledWith(3, 0);
  });

  it('voltar atrás no meio do arraste devolve as vizinhas ao lugar', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    press('Logo', 0);
    moveTo(75);
    expect(row('Site').style.transform).toBe(`translateY(-${STEP}px)`);
    moveTo(30);
    expect(transforms()).toEqual([
      'translateY(10px)',
      'translateY(0px)',
      'translateY(0px)',
      'translateY(0px)',
    ]);

    // Soltou no próprio lugar: nada é gravado e tudo volta.
    release();
    expect(onDrop).not.toHaveBeenCalled();
    expect(transforms()).toEqual(['', '', '', '']);
  });

  it('toque parado na alça (menos de 4 px) não arrasta nem grava', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    press('Site', 1, { pointerType: 'touch' });
    moveTo(middle(1) + 3);
    expect(transforms()).toEqual(['', '', '', '']);

    release();
    expect(onDrop).not.toHaveBeenCalled();
    expect(status()).toBe('Nada sendo arrastado');
  });

  it('a partir de 4 px o arraste vale, para cima ou para baixo', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);

    press('Site', 1, { pointerType: 'touch' });
    moveTo(middle(1) - 4);

    expect(row('Site').style.transform).toBe('translateY(-4px)');
  });

  it('a página ganha a marca de arraste só enquanto ele dura', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    expect(document.body).not.toHaveClass('is-dragging-list');
    press('Logo', 0);
    expect(document.body).toHaveClass('is-dragging-list');
    release();
    expect(document.body).not.toHaveClass('is-dragging-list');
  });
});

describe('o que não começa um arraste', () => {
  it('botão direito do mouse não arrasta (e o menu de contexto segue normal)', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    expect(press('Logo', 0, { button: 2 })).toBe(true);
    expect(status()).toBe('Nada sendo arrastado');
    expect(document.body).not.toHaveClass('is-dragging-list');
  });

  it('lista de um item só não tem ordem para mudar', () => {
    const onDrop = vi.fn();
    render(<SortableList items={['Logo']} onDrop={onDrop} />);
    expect(press('Logo', 0)).toBe(true);
    moveTo(300);
    release();
    expect(status()).toBe('Nada sendo arrastado');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('um arraste por vez: um segundo ponteiro na alça de outra linha é ignorado', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);

    press('Logo', 0);
    press('Vitrine', 2, { pointerId: 2 });
    expect(status()).toBe('Arrastando Logo');

    // O movimento e a soltura do outro ponteiro também não contam.
    moveTo(160, 2);
    expect(transforms()).toEqual(['', '', '', '']);
    release(2);
    expect(status()).toBe('Arrastando Logo');
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('cancelar', () => {
  it('Esc devolve tudo ao lugar sem gravar, e o Esc não vaza para a página', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(125);

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false);

    expect(transforms()).toEqual(['', '', '', '']);
    expect(status()).toBe('Nada sendo arrastado');
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('outra tecla não cancela: o arraste continua e solta normalmente', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);

    expect(fireEvent.keyDown(window, { key: 'a' })).toBe(true);
    expect(status()).toBe('Arrastando Logo');

    release();
    expect(onDrop).toHaveBeenCalledWith(0, 1);
  });

  it('o sistema cancelar o ponteiro (pointercancel) devolve tudo sem gravar', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(125);

    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect(transforms()).toEqual(['', '', '', '']);
    expect(status()).toBe('Nada sendo arrastado');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a linha que volta fica por cima das vizinhas até terminar de deslizar', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Logo', 0);
    moveTo(125);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(row('Logo').style.zIndex).toBe('2');
    fireEvent.transitionEnd(row('Logo'));
    expect(row('Logo').style.zIndex).toBe('');
  });

  it('começar outro arraste logo depois do Esc tira a linha anterior de cima na hora', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Logo', 0);
    moveTo(125);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(row('Logo').style.zIndex).toBe('2');

    press('Vitrine', 2);

    expect(status()).toBe('Arrastando Vitrine');
    expect(row('Logo').style.zIndex).toBe('');
  });

  it('sem transição (movimento reduzido), a linha sai de cima sozinha depois de 400 ms', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Logo', 0);
    moveTo(125);
    fireEvent.keyDown(window, { key: 'Escape' });

    act(() => vi.advanceTimersByTime(399));
    expect(row('Logo').style.zIndex).toBe('2');
    act(() => vi.advanceTimersByTime(1));
    expect(row('Logo').style.zIndex).toBe('');
  });
});

describe('depois de soltar: a linha espera a ordem nova', () => {
  it('as linhas ficam onde foram soltas até a ordem chegar; aí tudo assenta', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();

    // Ainda na ordem velha: a prévia continua na tela, com a arrastada por cima.
    expect(transforms()).toEqual([
      'translateY(55px)',
      `translateY(-${STEP}px)`,
      'translateY(0px)',
      'translateY(0px)',
    ]);
    expect(row('Logo').style.zIndex).toBe('2');

    rerender(<SortableList items={['Site', 'Logo', 'Vitrine', 'Cardápio']} onDrop={onDrop} />);

    expect(transforms()).toEqual(['', '', '', '']);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Site',
      'Logo',
      'Vitrine',
      'Cardápio',
    ]);
    act(() => vi.advanceTimersByTime(400));
    expect(row('Logo').style.zIndex).toBe('');
  });

  it('enquanto a ordem nova não chega, outro arraste não começa', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();

    expect(press('Vitrine', 2)).toBe(true);
    expect(status()).toBe('Nada sendo arrastado');
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('se a ordem nunca chega (gravação falhou), as linhas voltam depois do tempo limite', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();

    act(() => vi.advanceTimersByTime(SETTLE_MS - 1));
    expect(row('Logo').style.transform).toBe('translateY(55px)');
    act(() => vi.advanceTimersByTime(1));
    expect(transforms()).toEqual(['', '', '', '']);

    // E a lista volta a aceitar arraste.
    press('Vitrine', 2);
    expect(status()).toBe('Arrastando Vitrine');
  });

  it('a ordem chegou a tempo: o tempo limite não mexe mais em nada', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();
    rerender(<SortableList items={['Site', 'Logo', 'Vitrine', 'Cardápio']} onDrop={onDrop} />);

    // Novo arraste em andamento quando o tempo limite antigo venceria.
    press('Cardápio', 3);
    moveTo(60);
    act(() => vi.advanceTimersByTime(SETTLE_MS));

    expect(row('Cardápio').style.transform).toBe('translateY(-110px)');
    expect(status()).toBe('Arrastando Cardápio');
  });

  it('a linha solta foi removida da lista: a espera é descartada e a lista aceita arraste', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();

    rerender(<SortableList items={['Site', 'Vitrine', 'Cardápio']} onDrop={onDrop} />);

    expect(transforms()).toEqual(['', '', '']);
    press('Site', 0);
    expect(status()).toBe('Arrastando Site');
  });

  it('a lista saiu e voltou enquanto a linha esperava: a espera é descartada e outro arraste começa', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();

    rerender(<SortableList items={LIST} onDrop={onDrop} visible={false} />);
    rerender(<SortableList items={LIST} onDrop={onDrop} />);

    // Bem antes do tempo limite: a lista nova já aceita arraste.
    press('Vitrine', 2);
    expect(status()).toBe('Arrastando Vitrine');
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('o onDrop chamado é sempre o do render mais recente', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={first} />);
    press('Logo', 0);
    rerender(<SortableList items={LIST} onDrop={latest} />);
    moveTo(75);
    release();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(0, 1);
  });
});

describe('a lista muda por baixo do arraste', () => {
  it('a ordem mudou no meio (outra aba gravou): o arraste acaba sem gravar', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);

    rerender(<SortableList items={['Vitrine', 'Logo', 'Site', 'Cardápio']} onDrop={onDrop} />);

    expect(status()).toBe('Nada sendo arrastado');
    expect(transforms()).toEqual(['', '', '', '']);
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a lista saiu da tela (virou erro): no quadro seguinte o arraste acaba sem gravar', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);

    rerender(<SortableList items={LIST} onDrop={onDrop} visible={false} />);
    expect(status()).toBe('Arrastando Logo');
    act(() => vi.advanceTimersByTime(16));

    expect(status()).toBe('Nada sendo arrastado');
    expect(document.body).not.toHaveClass('is-dragging-list');
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a lista sumiu e a soltura chegou antes do quadro seguinte: não grava', () => {
    const onDrop = vi.fn();
    const { rerender } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);

    rerender(<SortableList items={LIST} onDrop={onDrop} visible={false} />);
    release();

    expect(onDrop).not.toHaveBeenCalled();
    expect(status()).toBe('Nada sendo arrastado');
  });

  it('a tela foi desmontada no meio do arraste: os ouvintes da janela são soltos', () => {
    const onDrop = vi.fn();
    const { unmount } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);

    unmount();

    expect(document.body).not.toHaveClass('is-dragging-list');
    release();
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('desmontar com a linha ainda esperando a ordem nova cancela o tempo limite', () => {
    const onDrop = vi.fn();
    const { unmount } = render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(75);
    release();
    const dropped = row('Logo');

    unmount();
    act(() => vi.advanceTimersByTime(SETTLE_MS));

    // O tempo limite não rodou: ninguém mexeu na linha depois que a tela saiu.
    expect(dropped.style.transform).toBe('translateY(55px)');
  });
});

describe('rolagem durante o arraste', () => {
  it('perto da borda de baixo da janela a página rola sozinha, a cada quadro', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Logo', 0);
    moveTo(760); // janela de 768 px: a 8 px da borda

    act(() => vi.advanceTimersByTime(16));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith(0, 12);
    act(() => vi.advanceTimersByTime(16));
    expect(scrollBy).toHaveBeenCalledTimes(2);
  });

  it('perto da borda de cima rola para cima', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Cardápio', 3);
    moveTo(0);
    act(() => vi.advanceTimersByTime(16));
    expect(scrollBy).toHaveBeenCalledWith(0, -14);
  });

  it('no meio da janela, ou antes de o arraste valer, a página não rola', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Logo', 0);
    act(() => vi.advanceTimersByTime(48));
    moveTo(400);
    act(() => vi.advanceTimersByTime(48));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('solto o ponteiro, a rolagem automática para', () => {
    render(<SortableList items={LIST} onDrop={vi.fn()} />);
    press('Logo', 0);
    moveTo(760);
    release();
    act(() => vi.advanceTimersByTime(64));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('a página rolou com o ponteiro parado: a linha acompanha a rolagem', () => {
    const onDrop = vi.fn();
    render(<SortableList items={LIST} onDrop={onDrop} />);
    press('Logo', 0);
    moveTo(40);
    expect(row('Logo').style.transform).toBe('translateY(20px)');

    setScrollY(35);
    fireEvent.scroll(window);

    // 20 px do ponteiro + 35 px da rolagem: a borda de baixo (95) passou do meio de "Site".
    expect(row('Logo').style.transform).toBe('translateY(55px)');
    expect(row('Site').style.transform).toBe(`translateY(-${STEP}px)`);
    release();
    expect(onDrop).toHaveBeenCalledWith(0, 1);
  });
});
