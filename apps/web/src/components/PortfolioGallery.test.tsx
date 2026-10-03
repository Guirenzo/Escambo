import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PortfolioItem } from '@escambo/types';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioGallery } from './PortfolioGallery';

/**
 * Galeria do portfólio (ADR 40 e 43): diálogo em tela cheia, navegação em círculo, foco preso,
 * zoom pelo teclado, botões, roda, duplo clique, duplo toque e pinça. O jsdom não tem layout: a
 * moldura da imagem é de mentira (800 × 600, com o centro em 500, 350) e a imagem "natural" tem
 * 1600 × 1200, que ocupa a moldura inteira.
 */

const media = (last: string): string => `/api/media/2026/09/01ARZ3NDEKTSV4RRFFQ69G5FA${last}.webp`;
const LOGO = media('A');
const SITE = media('C');
const CARTAZ = 'https://cdn.example/cartaz.jpg';
const SIZES = '(max-width: 720px) 100vw, min(1100px, 92vw)';

const item = (o: Partial<PortfolioItem> & { id: number; title: string }): PortfolioItem => ({
  description: null,
  imageUrl: null,
  externalUrl: null,
  sortOrder: o.id,
  ...o,
});

/** Três trabalhos com imagem (1, 3 e 4) e um só de texto, que a galeria pula. */
const items: PortfolioItem[] = [
  item({
    id: 1,
    title: 'Logo da padaria',
    description: 'Identidade visual completa',
    imageUrl: LOGO,
    externalUrl: 'https://behance.example/logo',
  }),
  item({ id: 2, title: 'Texto de apresentação', description: 'Só texto' }),
  item({ id: 3, title: 'Cartaz do festival', imageUrl: CARTAZ }),
  item({ id: 4, title: 'Site da clínica', description: 'Layout responsivo', imageUrl: SITE }),
];

const onShow = vi.fn();
const onClose = vi.fn();
const onReport = vi.fn();

/** A tela de quem usa: um botão abre o trabalho, e a galeria troca e fecha de verdade. */
function Page({
  list = items,
  start,
  report = false,
}: {
  list?: PortfolioItem[];
  start: number;
  report?: boolean;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <>
      <button type="button" onClick={() => setOpenId(start)}>
        Abrir trabalho
      </button>
      {openId !== null && (
        <PortfolioGallery
          items={list}
          openId={openId}
          onShow={(id) => {
            onShow(id);
            setOpenId(id);
          }}
          onClose={() => {
            onClose();
            setOpenId(null);
          }}
          onReport={report ? onReport : undefined}
        />
      )}
    </>
  );
}

async function open(start: number, props: { list?: PortfolioItem[]; report?: boolean } = {}) {
  const user = userEvent.setup();
  render(<Page start={start} {...props} />);
  await user.click(screen.getByRole('button', { name: 'Abrir trabalho' }));
  return user;
}

let natural = { width: 1600, height: 1200 };
/** O que a galeria pediu antes, para as imagens vizinhas. */
let preloaded: { src: string; srcset: string; sizes: string }[];

beforeEach(() => {
  onShow.mockReset();
  onClose.mockReset();
  onReport.mockReset();
  natural = { width: 1600, height: 1200 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        left: 100,
        top: 50,
        width: 800,
        height: 600,
        right: 900,
        bottom: 650,
        x: 100,
        y: 50,
      }) as DOMRect,
  );
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(
    () => natural.width,
  );
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockImplementation(
    () => natural.height,
  );
  preloaded = [];
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      srcset = '';
      sizes = '';
      constructor() {
        preloaded.push(this);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

const dialog = (): HTMLElement => screen.getByRole('dialog');
const picture = (title: string): HTMLImageElement => screen.getByRole('img', { name: title });
/** O palco (fundo escuro em volta da imagem): não tem papel, é o pai da moldura. */
const stage = (title: string): HTMLElement => picture(title).closest('figure')!.parentElement!;
/** Escala e deslocamento aplicados à imagem. */
const transform = (title: string): string => picture(title).parentElement!.style.transform;
const level = (): HTMLElement => screen.getByRole('button', { name: /amanho inteiro/ });
const placeholder = (): Element | null => dialog().querySelector('img[aria-hidden="true"]');

const mouse = (x: number, y: number, button = 0) => ({
  pointerType: 'mouse',
  pointerId: 1,
  button,
  clientX: x,
  clientY: y,
});
const touch = (id: number, x: number, y: number) => ({
  pointerType: 'touch',
  pointerId: id,
  button: 0,
  clientX: x,
  clientY: y,
});

/** Um toque parado, com a hora do evento escolhida (o duplo toque conta o tempo entre dois). */
function tap(el: Element, x: number, y: number, at: number): void {
  fireEvent.pointerDown(el, touch(1, x, y));
  const up = createEvent.pointerUp(el, touch(1, x, y));
  Object.defineProperty(up, 'timeStamp', { value: at });
  fireEvent(el, up);
}

/** Um dedo que encosta, anda e solta. */
function swipe(el: Element, from: [number, number], to: [number, number]): void {
  fireEvent.pointerDown(el, touch(1, from[0], from[1]));
  fireEvent.pointerMove(el, touch(1, to[0], to[1]));
  fireEvent.pointerUp(el, touch(1, to[0], to[1]));
}

describe('PortfolioGallery: abrir e fechar', () => {
  it('abre o trabalho como diálogo modal, com título, contador, descrição e link', async () => {
    await open(1);
    const d = screen.getByRole('dialog', { name: 'Logo da padaria' });
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(within(d).getByRole('heading', { level: 2, name: 'Logo da padaria' })).toBeVisible();
    // O trabalho sem imagem não conta: são 3, não 4.
    expect(within(d).getByText('1 de 3')).toBeInTheDocument();
    expect(within(d).getByText('Identidade visual completa')).toBeInTheDocument();
    const link = within(d).getByRole('link', { name: 'Ver trabalho' });
    expect(link).toHaveAttribute('href', 'https://behance.example/logo');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('trabalho sem descrição nem link não mostra legenda', async () => {
    await open(3);
    expect(screen.getByText('2 de 3')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(dialog().querySelector('p')).toBeNull();
  });

  it('trabalho com descrição e sem link mostra só o texto', async () => {
    await open(4);
    expect(screen.getByText('3 de 3')).toBeInTheDocument();
    expect(screen.getByText('Layout responsivo')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('id que não é de um trabalho com imagem não abre nada nem trava a página', async () => {
    await open(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByRole('button', { name: 'Abrir trabalho' })).toHaveFocus();
    expect(preloaded).toHaveLength(0);
  });

  it('ao abrir, o foco vai para o fechar e a rolagem da página trava', async () => {
    document.body.style.overflow = 'scroll';
    await open(1);
    expect(screen.getByRole('button', { name: 'Fechar galeria' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('o fechar encerra, devolve o foco a quem abriu e destrava a rolagem como estava', async () => {
    document.body.style.overflow = 'scroll';
    const user = await open(1);
    await user.click(screen.getByRole('button', { name: 'Fechar galeria' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir trabalho' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('Esc fecha', async () => {
    const user = await open(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onShow).not.toHaveBeenCalled();
  });

  it('clicar no fundo fecha; clicar na imagem não', async () => {
    const user = await open(1);
    await user.click(picture('Logo da padaria'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(stage('Logo da padaria'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('arrasto que começou na imagem e soltou no fundo não fecha', async () => {
    await open(1);
    fireEvent.pointerDown(picture('Logo da padaria'), mouse(500, 350));
    fireEvent.click(stage('Logo da padaria'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gesto que andou sobre o fundo não fecha ao soltar', async () => {
    await open(1);
    const bg = stage('Logo da padaria');
    fireEvent.pointerDown(bg, touch(1, 120, 300));
    fireEvent.pointerMove(bg, touch(1, 120, 340));
    fireEvent.pointerUp(bg, touch(1, 120, 340));
    fireEvent.click(bg);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PortfolioGallery: denunciar', () => {
  it('sem onReport não há botão de denúncia', async () => {
    await open(1);
    expect(screen.queryByRole('button', { name: /Denunciar/ })).not.toBeInTheDocument();
  });

  it('o botão denuncia o trabalho que está aberto', async () => {
    const user = await open(3, { report: true });
    await user.click(
      screen.getByRole('button', { name: 'Denunciar imagem de Cartaz do festival' }),
    );
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(items[2]);
  });
});

describe('PortfolioGallery: imagem', () => {
  it('imagem enviada ao Escambo vem responsiva (480, 960 e original) sobre a miniatura', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    expect(img).toHaveAttribute('src', `${LOGO}?w=960`);
    expect(img).toHaveAttribute('srcset', `${LOGO}?w=480 480w, ${LOGO}?w=960 960w, ${LOGO} 1600w`);
    expect(img).toHaveAttribute('sizes', SIZES);
    expect(placeholder()).toHaveAttribute('src', `${LOGO}?w=480`);
  });

  // A imagem grande fica transparente até carregar (CSS de .gallery-image): a classe "loaded" é o
  // que a mostra.
  it('quando a imagem grande chega, ela aparece e a miniatura desfocada sai', async () => {
    await open(1);
    expect(picture('Logo da padaria')).not.toHaveClass('loaded');
    fireEvent.load(picture('Logo da padaria'));
    expect(picture('Logo da padaria')).toHaveClass('loaded');
    expect(placeholder()).toBeNull();
  });

  it('trocar de trabalho volta a mostrar a miniatura do novo até ele carregar', async () => {
    const user = await open(1);
    fireEvent.load(picture('Logo da padaria'));
    await user.keyboard('{ArrowLeft}');
    expect(placeholder()).toHaveAttribute('src', `${SITE}?w=480`);
    expect(picture('Site da clínica')).not.toHaveClass('loaded');
    fireEvent.load(picture('Site da clínica'));
    expect(picture('Site da clínica')).toHaveClass('loaded');
    expect(placeholder()).toBeNull();
  });

  it('link externo vai como está: sem srcset e sem miniatura', async () => {
    await open(3);
    const img = picture('Cartaz do festival');
    expect(img).toHaveAttribute('src', CARTAZ);
    expect(img).not.toHaveAttribute('srcset');
    expect(img).not.toHaveAttribute('sizes');
    expect(placeholder()).toBeNull();
  });

  it('pede antes as duas vizinhas, com as mesmas fontes que a tela vai usar', async () => {
    await open(1);
    expect(preloaded.map((p) => ({ src: p.src, srcset: p.srcset, sizes: p.sizes }))).toEqual([
      { src: CARTAZ, srcset: '', sizes: '' },
      {
        src: `${SITE}?w=960`,
        srcset: `${SITE}?w=480 480w, ${SITE}?w=960 960w, ${SITE} 1600w`,
        sizes: SIZES,
      },
    ]);
  });

  it('não pede as vizinhas de novo a cada render, só quando muda de trabalho', async () => {
    const user = await open(1);
    await user.keyboard('+');
    await user.keyboard('0');
    expect(preloaded).toHaveLength(2);
    await user.keyboard('{ArrowRight}');
    expect(preloaded).toHaveLength(4);
    expect(preloaded.slice(2).map((p) => p.src)).toEqual([`${SITE}?w=960`, `${LOGO}?w=960`]);
  });

  it('com um trabalho só, não há vizinha para pedir', async () => {
    await open(1, { list: [items[0]!, items[1]!] });
    expect(screen.getByText('1 de 1')).toBeInTheDocument();
    expect(preloaded).toHaveLength(0);
  });
});

describe('PortfolioGallery: navegar', () => {
  it('seta para a direita vai ao próximo trabalho com imagem', async () => {
    const user = await open(1);
    await user.keyboard('{ArrowRight}');
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith(3);
    expect(screen.getByRole('dialog', { name: 'Cartaz do festival' })).toBeInTheDocument();
    expect(screen.getByText('2 de 3')).toBeInTheDocument();
  });

  it('é um círculo: antes do primeiro vem o último, depois do último vem o primeiro', async () => {
    const user = await open(1);
    await user.keyboard('{ArrowLeft}');
    expect(onShow).toHaveBeenLastCalledWith(4);
    expect(screen.getByText('3 de 3')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(onShow).toHaveBeenLastCalledWith(1);
    expect(screen.getByText('1 de 3')).toBeInTheDocument();
  });

  it('os botões de anterior e próximo fazem o mesmo que as setas', async () => {
    const user = await open(3);
    await user.click(screen.getByRole('button', { name: 'Próximo trabalho' }));
    expect(onShow).toHaveBeenLastCalledWith(4);
    await user.click(screen.getByRole('button', { name: 'Trabalho anterior' }));
    expect(onShow).toHaveBeenLastCalledWith(3);
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it('Home vai ao primeiro e End ao último', async () => {
    const user = await open(3);
    await user.keyboard('{End}');
    expect(onShow).toHaveBeenLastCalledWith(4);
    await user.keyboard('{Home}');
    expect(onShow).toHaveBeenLastCalledWith(1);
  });

  it('com um trabalho só não há botões de navegação, e as teclas não trocam nada', async () => {
    const user = await open(1, { list: [items[0]!] });
    expect(screen.queryByRole('button', { name: 'Próximo trabalho' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trabalho anterior' })).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}{ArrowLeft}{Home}{End}');
    expect(onShow).not.toHaveBeenCalled();
  });

  it('as teclas da galeria não vazam para a página; as outras passam', async () => {
    await open(1);
    const close = screen.getByRole('button', { name: 'Fechar galeria' });
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', '+', '=', '-', '0', 'Escape']) {
      expect(fireEvent.keyDown(close, { key }), key).toBe(false);
    }
  });

  it('inteira, setas para cima e para baixo não são da galeria (a página rola a legenda)', async () => {
    await open(1);
    const close = screen.getByRole('button', { name: 'Fechar galeria' });
    expect(fireEvent.keyDown(close, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(close, { key: 'ArrowUp' })).toBe(true);
    expect(fireEvent.keyDown(close, { key: 'a' })).toBe(true);
    expect(onShow).not.toHaveBeenCalled();
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('deslizar o dedo para a esquerda vai ao próximo; para a direita, ao anterior', async () => {
    await open(1);
    swipe(picture('Logo da padaria'), [500, 300], [400, 305]);
    expect(onShow).toHaveBeenLastCalledWith(3);
    swipe(picture('Cartaz do festival'), [400, 300], [500, 295]);
    expect(onShow).toHaveBeenLastCalledWith(1);
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it('deslize curto, ou mais vertical que horizontal, não troca de trabalho', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    swipe(img, [500, 300], [470, 300]);
    swipe(img, [500, 300], [430, 400]);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('arrastar com o mouse não troca de trabalho', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, mouse(500, 300));
    fireEvent.pointerMove(img, mouse(380, 300));
    fireEvent.pointerUp(img, mouse(380, 300));
    expect(onShow).not.toHaveBeenCalled();
  });

  it('gesto cancelado pelo sistema não vira deslize', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, touch(1, 500, 300));
    fireEvent.pointerCancel(img, touch(1, 500, 300));
    fireEvent.pointerMove(img, touch(1, 380, 300));
    fireEvent.pointerUp(img, touch(1, 380, 300));
    expect(onShow).not.toHaveBeenCalled();
  });

  it('dedo que começa num botão do palco não vira deslize (o botão cuida do clique)', async () => {
    await open(1);
    swipe(screen.getByRole('button', { name: 'Próximo trabalho' }), [860, 350], [700, 350]);
    expect(onShow).not.toHaveBeenCalled();
  });
});

describe('PortfolioGallery: foco preso', () => {
  it('Tab no último controle volta ao primeiro, e Shift+Tab no primeiro vai ao último', async () => {
    const user = await open(1, { report: true });
    const first = screen.getByRole('button', { name: 'Denunciar imagem de Logo da padaria' });
    const last = screen.getByRole('link', { name: 'Ver trabalho' });
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('no meio do diálogo o Tab segue a ordem dos controles', async () => {
    const user = await open(1);
    expect(screen.getByRole('button', { name: 'Fechar galeria' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Trabalho anterior' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reduzir imagem' })).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Fechar galeria' })).toHaveFocus();
    // Fechar é o primeiro aqui (sem denúncia): Shift+Tab dá a volta para o link da legenda.
    await user.tab({ shift: true });
    expect(screen.getByRole('link', { name: 'Ver trabalho' })).toHaveFocus();
  });
});

describe('PortfolioGallery: zoom', () => {
  it('abre inteira: 100%, reduzir e voltar ao inteiro indisponíveis, ampliar disponível', async () => {
    await open(1);
    expect(screen.getByRole('group', { name: 'Zoom da imagem' })).toBeInTheDocument();
    const whole = screen.getByRole('button', { name: 'Tamanho inteiro (100%)' });
    expect(whole).toHaveTextContent(/^100%$/);
    expect(whole).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Reduzir imagem' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Ampliar imagem' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('+ amplia 1,5×, - reduz e 0 volta ao inteiro', async () => {
    const user = await open(1);
    await user.keyboard('+');
    expect(
      screen.getByRole('button', { name: 'Voltar ao tamanho inteiro (150%)' }),
    ).toHaveAttribute('aria-disabled', 'false');
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(1.5)');
    await user.keyboard('=');
    expect(level()).toHaveTextContent(/^225%$/);
    await user.keyboard('-');
    expect(level()).toHaveTextContent(/^150%$/);
    await user.keyboard('0');
    expect(level()).toHaveTextContent(/^100%$/);
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('os botões ampliam e reduzem; o do meio volta ao inteiro', async () => {
    const user = await open(1);
    await user.click(screen.getByRole('button', { name: 'Ampliar imagem' }));
    await user.click(screen.getByRole('button', { name: 'Ampliar imagem' }));
    expect(level()).toHaveTextContent(/^225%$/);
    expect(screen.getByRole('button', { name: 'Reduzir imagem' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await user.click(screen.getByRole('button', { name: 'Reduzir imagem' }));
    expect(level()).toHaveTextContent(/^150%$/);
    await user.click(screen.getByRole('button', { name: 'Voltar ao tamanho inteiro (150%)' }));
    expect(screen.getByRole('button', { name: 'Tamanho inteiro (100%)' })).toBeInTheDocument();
  });

  it('o zoom para em 400% e avisa que não dá para ampliar mais', async () => {
    const user = await open(1);
    await user.keyboard('++++');
    expect(level()).toHaveTextContent(/^400%$/);
    expect(screen.getByRole('button', { name: 'Ampliar imagem' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Ampliar imagem' }));
    expect(level()).toHaveTextContent(/^400%$/);
  });

  it('reduzir no tamanho inteiro não passa de 100%', async () => {
    const user = await open(1);
    await user.click(screen.getByRole('button', { name: 'Reduzir imagem' }));
    await user.keyboard('-');
    expect(level()).toHaveTextContent(/^100%$/);
  });

  it('ampliada, pede ao navegador a versão da largura ampliada; inteira, volta ao padrão', async () => {
    const user = await open(1);
    await user.keyboard('+');
    // 800 px desenhados × 1,5.
    expect(picture('Logo da padaria')).toHaveAttribute('sizes', '1200px');
    await user.keyboard('0');
    expect(picture('Logo da padaria')).toHaveAttribute('sizes', SIZES);
  });

  it('ampliada, as setas deslocam a imagem em vez de trocar de trabalho', async () => {
    const user = await open(1);
    await user.keyboard('+');
    await user.keyboard('{ArrowRight}');
    // A seta mostra o lado para onde aponta: a imagem anda 80 px para o outro lado.
    expect(transform('Logo da padaria')).toBe('translate3d(-80px, 0px, 0) scale(1.5)');
    await user.keyboard('{ArrowDown}');
    expect(transform('Logo da padaria')).toBe('translate3d(-80px, -80px, 0) scale(1.5)');
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowUp}{ArrowUp}');
    expect(transform('Logo da padaria')).toBe('translate3d(80px, 80px, 0) scale(1.5)');
    expect(onShow).not.toHaveBeenCalled();
  });

  it('o deslocamento para quando a borda da imagem encosta na da moldura', async () => {
    const user = await open(1);
    await user.keyboard('+');
    // 1200 × 900 numa moldura de 800 × 600: sobram 200 px para cada lado e 150 para cima e baixo.
    await user.keyboard('{ArrowRight>5/}{ArrowDown>5/}');
    expect(transform('Logo da padaria')).toBe('translate3d(-200px, -150px, 0) scale(1.5)');
  });

  it('imagem larga ampliada que ainda cabe na altura fica centrada na vertical', async () => {
    natural = { width: 1600, height: 600 };
    const user = await open(1);
    await user.keyboard('+');
    // Desenhada com 800 × 300: ampliada tem 1200 × 450, menor que os 600 da moldura.
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(transform('Logo da padaria')).toBe('translate3d(-80px, 0px, 0) scale(1.5)');
  });

  it('imagem que ainda não carregou (sem tamanho natural) usa a moldura inteira', async () => {
    natural = { width: 0, height: 0 };
    const user = await open(1);
    await user.keyboard('+');
    await user.keyboard('{ArrowRight>5/}');
    expect(transform('Logo da padaria')).toBe('translate3d(-200px, 0px, 0) scale(1.5)');
  });

  it('trocar de trabalho volta ao tamanho inteiro', async () => {
    const user = await open(1);
    await user.keyboard('+');
    await user.click(screen.getByRole('button', { name: 'Próximo trabalho' }));
    expect(onShow).toHaveBeenLastCalledWith(3);
    expect(screen.getByRole('button', { name: 'Tamanho inteiro (100%)' })).toBeInTheDocument();
    expect(transform('Cartaz do festival')).toBe('translate3d(0px, 0px, 0) scale(1)');
    // Inteira de novo, a seta volta a trocar de trabalho.
    await user.keyboard('{ArrowRight}');
    expect(onShow).toHaveBeenLastCalledWith(4);
  });

  it('a roda do mouse amplia cerca de 20% por passo, com o ponto sob o cursor parado', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.wheel(img, { deltaY: -100, clientX: 500, clientY: 350 });
    expect(level()).toHaveTextContent(/^122%$/);
    // Cursor 200 px à direita do centro: a imagem cresce para a esquerda dele.
    fireEvent.wheel(img, { deltaY: -100, clientX: 700, clientY: 350 });
    expect(level()).toHaveTextContent(/^149%$/);
    const x = Number(/translate3d\((-?[\d.]+)px/.exec(transform('Logo da padaria'))![1]);
    expect(x).toBeCloseTo(200 - 200 * Math.exp(0.2), 5);
    fireEvent.wheel(img, { deltaY: 1000, clientX: 500, clientY: 350 });
    expect(level()).toHaveTextContent(/^100%$/);
  });

  // A animação (transição do CSS) é das mudanças em saltos; o que segue a mão não pode atrasar.
  it('teclas e botões animam o zoom; roda e dedos acompanham sem atraso', async () => {
    const user = await open(1);
    const canvas = (): HTMLElement => picture('Logo da padaria').parentElement!;
    const figure = (): HTMLElement => picture('Logo da padaria').closest('figure')!;
    expect(canvas()).not.toHaveClass('smooth');
    expect(figure()).not.toHaveClass('zoomed');
    await user.keyboard('+');
    expect(canvas()).toHaveClass('smooth');
    // Ampliada, o cursor vira a mãozinha de arrastar.
    expect(figure()).toHaveClass('zoomed');
    fireEvent.wheel(picture('Logo da padaria'), { deltaY: -100, clientX: 500, clientY: 350 });
    expect(canvas()).not.toHaveClass('smooth');
    await user.click(screen.getByRole('button', { name: /^Voltar ao tamanho inteiro/ }));
    expect(canvas()).toHaveClass('smooth');
    expect(figure()).not.toHaveClass('zoomed');
    fireEvent.pointerDown(picture('Logo da padaria'), touch(1, 400, 350));
    fireEvent.pointerDown(picture('Logo da padaria'), touch(2, 600, 350));
    fireEvent.pointerMove(picture('Logo da padaria'), touch(2, 700, 350));
    expect(canvas()).not.toHaveClass('smooth');
  });

  it('roda sem movimento vertical não muda nada', async () => {
    await open(1);
    fireEvent.wheel(picture('Logo da padaria'), { deltaY: 0, deltaX: 80 });
    expect(level()).toHaveTextContent(/^100%$/);
  });

  it('Ctrl + roda dentro da galeria não amplia a página inteira', async () => {
    await open(1);
    const bg = stage('Logo da padaria');
    expect(fireEvent.wheel(bg, { deltaY: -100, ctrlKey: true })).toBe(false);
    expect(fireEvent.wheel(bg, { deltaY: -100 })).toBe(true);
  });

  it('duplo clique amplia para 250% no ponto clicado; outro duplo clique volta ao inteiro', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, mouse(700, 350));
    fireEvent.pointerUp(img, mouse(700, 350));
    fireEvent.dblClick(img, { clientX: 700, clientY: 350 });
    expect(level()).toHaveTextContent(/^250%$/);
    // O ponto clicado (200 px à direita do centro) fica onde estava: 200 − 200 × 2,5.
    expect(transform('Logo da padaria')).toBe('translate3d(-300px, 0px, 0) scale(2.5)');
    fireEvent.dblClick(img, { clientX: 700, clientY: 350 });
    expect(level()).toHaveTextContent(/^100%$/);
  });

  it('duplo clique num botão do zoom vale como dois cliques, sem voltar ao inteiro', async () => {
    const user = await open(1);
    await user.dblClick(screen.getByRole('button', { name: 'Ampliar imagem' }));
    expect(level()).toHaveTextContent(/^225%$/);
  });

  it('no toque, o duplo clique do navegador é ignorado: quem amplia é o duplo toque', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    tap(img, 500, 350, 1000);
    fireEvent.dblClick(img, { clientX: 500, clientY: 350 });
    expect(level()).toHaveTextContent(/^100%$/);
  });

  it('dois toques seguidos e próximos ampliam para 250%; mais dois voltam ao inteiro', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    tap(img, 500, 350, 1000);
    expect(level()).toHaveTextContent(/^100%$/);
    tap(img, 510, 355, 1200);
    expect(level()).toHaveTextContent(/^250%$/);
    tap(img, 500, 350, 3000);
    expect(level()).toHaveTextContent(/^250%$/);
    tap(img, 500, 350, 3100);
    expect(level()).toHaveTextContent(/^100%$/);
  });

  it('toques demorados (300 ms ou mais) ou longe um do outro não são duplo toque', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    tap(img, 500, 350, 1000);
    tap(img, 500, 350, 1300);
    expect(level()).toHaveTextContent(/^100%$/);
    // O segundo toque passa a ser o primeiro de um novo par: perto no tempo, longe no espaço.
    tap(img, 560, 350, 1400);
    expect(level()).toHaveTextContent(/^100%$/);
    tap(img, 565, 350, 1500);
    expect(level()).toHaveTextContent(/^250%$/);
  });

  it('clique simples do mouse não conta como toque', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    for (const at of [1000, 1100]) {
      fireEvent.pointerDown(img, mouse(500, 350));
      const up = createEvent.pointerUp(img, mouse(500, 350));
      Object.defineProperty(up, 'timeStamp', { value: at });
      fireEvent(img, up);
    }
    expect(level()).toHaveTextContent(/^100%$/);
  });

  it('ampliada, arrastar desloca a imagem (mouse ou dedo) e não troca de trabalho', async () => {
    const user = await open(1);
    await user.keyboard('+');
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, mouse(500, 300));
    fireEvent.pointerMove(img, mouse(450, 320));
    expect(transform('Logo da padaria')).toBe('translate3d(-50px, 20px, 0) scale(1.5)');
    // O deslocamento é sempre a partir de onde a imagem estava quando o arrasto começou.
    fireEvent.pointerMove(img, mouse(420, 300));
    expect(transform('Logo da padaria')).toBe('translate3d(-80px, 0px, 0) scale(1.5)');
    fireEvent.pointerUp(img, mouse(420, 300));

    swipe(img, [500, 300], [380, 300]);
    expect(transform('Logo da padaria')).toBe('translate3d(-200px, 0px, 0) scale(1.5)');
    expect(onShow).not.toHaveBeenCalled();
  });

  it('só o botão esquerdo do mouse arrasta', async () => {
    const user = await open(1);
    await user.keyboard('+');
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, mouse(500, 300, 2));
    fireEvent.pointerMove(img, mouse(400, 300, 2));
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(1.5)');
  });

  it('ponteiro que não começou o gesto não desloca a imagem', async () => {
    const user = await open(1);
    await user.keyboard('+');
    const img = picture('Logo da padaria');
    fireEvent.pointerMove(img, mouse(400, 300));
    fireEvent.pointerUp(img, mouse(400, 300));
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(1.5)');
  });

  it('pinça: a escala acompanha a distância entre os dedos e o meio deles arrasta a imagem', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, touch(1, 400, 350));
    fireEvent.pointerDown(img, touch(2, 600, 350));
    // De 200 para 400 px entre os dedos: 2×. O meio foi de 500 para 600: 100 px para a direita.
    fireEvent.pointerMove(img, touch(2, 800, 350));
    expect(level()).toHaveTextContent(/^200%$/);
    expect(transform('Logo da padaria')).toBe('translate3d(100px, 0px, 0) scale(2)');
    expect(picture('Logo da padaria')).toHaveAttribute('sizes', '1600px');
  });

  it('depois da pinça, o dedo que sobra continua arrastando e soltar não troca de trabalho', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, touch(1, 400, 350));
    fireEvent.pointerDown(img, touch(2, 600, 350));
    fireEvent.pointerMove(img, touch(2, 800, 350));
    fireEvent.pointerUp(img, touch(2, 800, 350));
    fireEvent.pointerMove(img, touch(1, 300, 350));
    expect(transform('Logo da padaria')).toBe('translate3d(0px, 0px, 0) scale(2)');
    fireEvent.pointerUp(img, touch(1, 300, 350));
    expect(onShow).not.toHaveBeenCalled();
    expect(level()).toHaveTextContent(/^200%$/);
  });

  it('pinça que fecha de volta ao inteiro e solta os dois dedos não troca de trabalho', async () => {
    await open(1);
    const img = picture('Logo da padaria');
    fireEvent.pointerDown(img, touch(1, 300, 350));
    fireEvent.pointerDown(img, touch(2, 700, 350));
    fireEvent.pointerMove(img, touch(2, 400, 350));
    expect(level()).toHaveTextContent(/^100%$/);
    fireEvent.pointerUp(img, touch(2, 400, 350));
    const lastFinger = createEvent.pointerUp(img, touch(1, 300, 350));
    Object.defineProperty(lastFinger, 'timeStamp', { value: 5000 });
    fireEvent(img, lastFinger);
    expect(onShow).not.toHaveBeenCalled();
    // E o dedo que encerrou a pinça não conta como o primeiro de um duplo toque.
    tap(img, 300, 350, 5100);
    expect(level()).toHaveTextContent(/^100%$/);
  });

  // Defeito de produção (PortfolioGallery.tsx, estado `view`): o zoom fica guardado com o id do
  // último trabalho ampliado e só é ignorado enquanto outro trabalho está aberto. Ampliar o 1
  // (150%), ir ao 3 e voltar ao 1 mostra o 1 de novo em 150%, contra "trocar de trabalho volta ao
  // tamanho inteiro" (ADR 43). Quando for corrigido, vira teste: abrir o 1, "+", "Próximo
  // trabalho", "Trabalho anterior" e conferir "Tamanho inteiro (100%)".
  it.todo('voltar a um trabalho que tinha ficado ampliado mostra-o inteiro, em 100%');
});
