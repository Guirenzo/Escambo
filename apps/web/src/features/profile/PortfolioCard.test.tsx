import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PortfolioItem } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioCard } from './PortfolioCard';
import { ToastProvider } from '../../lib/toast';

/**
 * Pegar e soltar pelo teclado (ADR 53). Este caminho não mede a tela — a prévia é a ordem de
 * verdade no DOM —, então ele cabe inteiro no jsdom: a ordem das linhas, o que é anunciado, o
 * foco e, principalmente, quantas vezes a ordem é gravada.
 */

const item = (id: number, title: string, sortOrder: number): PortfolioItem => ({
  id,
  title,
  description: null,
  imageUrl: null,
  externalUrl: null,
  sortOrder,
});

let lista: PortfolioItem[] = [];

vi.mock('../../lib/api', () => ({
  api: {
    myPortfolio: vi.fn(() => Promise.resolve(lista)),
    addPortfolioItem: vi.fn(() => Promise.resolve(undefined)),
    removePortfolioItem: vi.fn(() => Promise.resolve(undefined)),
    reorderPortfolio: vi.fn(() => Promise.resolve(undefined)),
    uploadImage: vi.fn(() => Promise.resolve({ url: '' })),
  },
}));

const { api } = await import('../../lib/api');
const reorderPortfolio = vi.mocked(api.reorderPortfolio);

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

/** Os títulos na ordem em que estão na tela. */
const titulos = (): string[] =>
  within(screen.getByTestId('portfolio-list'))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('strong')?.textContent ?? '');

const anuncio = (): string =>
  document.querySelector('.portfolio-announce')?.textContent?.trim() ?? '';

const alca = (titulo: string): HTMLElement =>
  screen.getByRole('button', { name: `Reordenar ${titulo}` });

beforeEach(() => {
  lista = [item(1, 'Logo', 0), item(2, 'Site', 1), item(3, 'Cardápio', 2), item(4, 'Vitrine', 3)];
  reorderPortfolio.mockClear();
  // Lacunas do jsdom que o arraste por ponteiro usa; aqui só precisam existir.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});

describe('portfólio: pegar e soltar pelo teclado (ADR 53)', () => {
  it('pega, move sem gravar e grava uma vez só ao soltar', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Vitrine').focus();
    await user.keyboard(' ');
    expect(alca('Vitrine')).toHaveAttribute('aria-pressed', 'true');
    expect(anuncio()).toBe(
      'Pegou Vitrine, 4º de 4. Setas movem, espaço solta, Esc ou Tab cancela.',
    );

    await user.keyboard('{ArrowUp}{ArrowUp}');
    // A prévia é a ordem de verdade na tela, e nada foi gravado ainda.
    expect(titulos()).toEqual(['Logo', 'Vitrine', 'Site', 'Cardápio']);
    expect(anuncio()).toBe('2º de 4.');
    expect(reorderPortfolio).not.toHaveBeenCalled();
    // O foco acompanha a linha que está na mão.
    expect(document.activeElement).toBe(alca('Vitrine'));

    await user.keyboard(' ');
    expect(reorderPortfolio).toHaveBeenCalledTimes(1);
    expect(reorderPortfolio).toHaveBeenCalledWith([1, 4, 2, 3]);
    expect(anuncio()).toBe('Vitrine agora é o 2º de 4.');
    expect(alca('Vitrine')).toHaveAttribute('aria-pressed', 'false');
  });

  it('Esc devolve a ordem e não grava nada', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Logo').focus();
    await user.keyboard(' {ArrowDown}{ArrowDown}');
    expect(titulos()).toEqual(['Site', 'Cardápio', 'Logo', 'Vitrine']);

    await user.keyboard('{Escape}');
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);
    expect(anuncio()).toBe('Cancelado. Logo continua no 1º de 4.');
    expect(reorderPortfolio).not.toHaveBeenCalled();
    expect(alca('Logo')).toHaveAttribute('aria-pressed', 'false');
  });

  it('sair pelo Tab cancela sem gravar, e o foco segue para o controle seguinte', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Site').focus();
    await user.keyboard(' {ArrowUp}');
    expect(titulos()).toEqual(['Site', 'Logo', 'Cardápio', 'Vitrine']);

    await user.tab();
    await waitFor(() => expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']));
    expect(reorderPortfolio).not.toHaveBeenCalled();
    // Sem armadilha: o foco saiu da alça e ficou num controle de verdade, não no corpo da página.
    expect(document.activeElement).not.toBe(alca('Site'));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(anuncio()).toBe('Cancelado. Site continua no 2º de 4.');
  });

  it('na ponta, avisa e não trava o cancelamento seguinte', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Logo').focus();
    await user.keyboard(' {ArrowUp}');
    expect(anuncio()).toBe('Começo da lista. 1º de 4.');
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);

    await user.keyboard('{Escape}');
    expect(anuncio()).toBe('Cancelado. Logo continua no 1º de 4.');
    expect(alca('Logo')).toHaveAttribute('aria-pressed', 'false');
  });

  it('pegar e soltar no mesmo lugar não gasta uma gravação', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Cardápio').focus();
    await user.keyboard('  '); // pega e solta
    expect(reorderPortfolio).not.toHaveBeenCalled();
    expect(anuncio()).toBe('Cardápio continua no 3º de 4.');
  });

  it('tecla segurada não alterna duas vezes nem inunda o anúncio', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    const grip = alca('Site');
    grip.focus();
    await user.keyboard(' ');
    expect(grip).toHaveAttribute('aria-pressed', 'true');
    // O navegador repete a tecla enquanto ela fica presa: cada repetição é ignorada.
    await user.keyboard('{ArrowDown>2/}'); // pressiona, repete, solta
    expect(titulos()).toEqual(['Logo', 'Cardápio', 'Site', 'Vitrine']);
    expect(anuncio()).toBe('3º de 4.');
  });

  it('clique de mouse na alça não pega, mas foca: mouse e teclado juntos funcionam', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    await user.click(alca('Site'));
    expect(alca('Site')).toHaveAttribute('aria-pressed', 'false');
    // Clique de ponteiro não fala: ele é o fim de um arraste, e falar apagaria a frase dele.
    expect(anuncio()).toBe('');
    expect(document.activeElement).toBe(alca('Site'));

    await user.keyboard(' ');
    expect(alca('Site')).toHaveAttribute('aria-pressed', 'true');
  });

  it('ativação sem ponteiro (leitor de tela) não pega e diz onde está o caminho', async () => {
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    // É assim que NVDA e JAWS ativam um botão no modo de navegação: clique sem ponteiro, em que
    // as setas não chegariam até nós. Pegar aqui deixaria o item preso na mão.
    fireEvent.click(alca('Site')); // clique sem ponteiro: detail 0
    expect(alca('Site')).toHaveAttribute('aria-pressed', 'false');
    expect(anuncio()).toBe('Pegue com espaço, ou use os botões de subir e descer.');
  });

  it('com um item na mão, as setas e o remover ficam fora de alcance', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Site').focus();
    await user.keyboard(' ');
    // Elas leem a ordem gravada; clicar durante a prévia contradiria o que está na tela.
    expect(screen.getByRole('button', { name: 'Mover Logo para cima' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remover Logo' })).toBeDisabled();
  });

  it('Enter pega e solta igual ao espaço', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Vitrine').focus();
    await user.keyboard('{Enter}');
    expect(alca('Vitrine')).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Enter}');
    expect(reorderPortfolio).toHaveBeenCalledTimes(1);
    expect(reorderPortfolio).toHaveBeenCalledWith([1, 2, 4, 3]);
  });

  it('espaço preso não solta sozinho: a repetição da tecla é ignorada', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    const grip = alca('Site');
    grip.focus();
    await user.keyboard(' ');
    expect(grip).toHaveAttribute('aria-pressed', 'true');
    // Segurar o espaço gera keydown repetido: soltar aqui seria um movimento que ninguém pediu.
    fireEvent.keyDown(grip, { key: ' ', repeat: true });
    fireEvent.keyDown(grip, { key: ' ', repeat: true });
    expect(alca('Site')).toHaveAttribute('aria-pressed', 'true');
    expect(reorderPortfolio).not.toHaveBeenCalled();
  });

  it('o ponteiro na alça cancela a pega em vez de arrastar por cima dela', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Vitrine').focus();
    await user.keyboard(' {ArrowUp}');
    expect(titulos()).toEqual(['Logo', 'Site', 'Vitrine', 'Cardápio']);

    // Com a prévia na tela, um arraste mediria a lista errada: o gesto cancela e não arrasta.
    fireEvent.pointerDown(alca('Logo'), { pointerId: 1, button: 0, pointerType: 'mouse' });
    await waitFor(() => expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']));
    expect(alca('Vitrine')).toHaveAttribute('aria-pressed', 'false');
    expect(reorderPortfolio).not.toHaveBeenCalled();
    expect(anuncio()).toBe('Cancelado. Vitrine continua no 4º de 4.');
  });

  it('gravação que falha: a ordem volta, o erro aparece e a prévia não fica mentindo', async () => {
    const user = userEvent.setup();
    reorderPortfolio.mockRejectedValueOnce(new Error('Não foi possível mudar a ordem'));
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Vitrine').focus();
    await user.keyboard(' {ArrowUp} ');
    expect(reorderPortfolio).toHaveBeenCalledTimes(1);

    expect(await screen.findByText('Não foi possível mudar a ordem')).toBeInTheDocument();
    // A prévia cai no mesmo tempo do assentamento do arraste (SETTLE_MS), e não fica para sempre.
    await waitFor(() => expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']), {
      timeout: 3000,
    });
  });

  it('depois de cancelar com Esc, o leitor de tela ainda ouve a dica na alça', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    alca('Site').focus();
    await user.keyboard(' {ArrowUp}{Escape}');
    expect(anuncio()).toBe('Cancelado. Site continua no 2º de 4.');

    // Esc não traz clique nenhum depois: a dica da próxima ativação não pode ser engolida.
    fireEvent.click(alca('Site'));
    expect(anuncio()).toBe('Pegue com espaço, ou use os botões de subir e descer.');
  });

  it('as setas seguem gravando na hora, uma por clique', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('Vitrine');

    await user.click(screen.getByRole('button', { name: 'Mover Vitrine para cima' }));
    expect(reorderPortfolio).toHaveBeenCalledTimes(1);
    expect(reorderPortfolio).toHaveBeenCalledWith([1, 2, 4, 3]);
    expect(anuncio()).toBe('Vitrine agora é o 3º de 4.');
  });
});
