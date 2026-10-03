import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PortfolioItem, UpsertPortfolioItemRequest } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PortfolioCard } from './PortfolioCard';
import { ToastProvider } from '../../lib/toast';

/**
 * O resto do cartão do portfólio (o teclado na alça está em PortfolioCard.test.tsx): o que a lista
 * mostra, adicionar um trabalho (com imagem enviada do aparelho ou link), remover, as setas e o
 * arraste pelo ponteiro. A API de mentira guarda a lista, para a tela recarregar o que foi gravado.
 */

let lista: PortfolioItem[] = [];
let proximoId = 100;

const myPortfolio = vi.fn();
const addPortfolioItem = vi.fn();
const removePortfolioItem = vi.fn();
const reorderPortfolio = vi.fn();
const uploadMedia = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    myPortfolio: () => myPortfolio(),
    addPortfolioItem: (body: unknown) => addPortfolioItem(body),
    removePortfolioItem: (id: number) => removePortfolioItem(id),
    reorderPortfolio: (ids: number[]) => reorderPortfolio(ids),
    uploadMedia: (file: Blob, name: string, purpose: string) => uploadMedia(file, name, purpose),
  },
}));

/** Imagem enviada ao Escambo: a lista e a prévia usam a miniatura pequena dela (ADR 38). */
const MEDIA = '/api/media/2026/09/01ARZ3NDEKTSV4RRFFQ69G5FAV.webp';

const item = (id: number, title: string, o: Partial<PortfolioItem> = {}): PortfolioItem => ({
  id,
  title,
  description: null,
  imageUrl: null,
  externalUrl: null,
  sortOrder: id,
  ...o,
});

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

/** Os títulos na ordem da tela, lidos do nome do botão de remover de cada linha. */
const titulos = (): string[] =>
  screen
    .getAllByRole('button', { name: /^Remover / })
    .map((b) => (b.getAttribute('aria-label') ?? '').replace(/^Remover /, ''));

const linha = (titulo: string): HTMLElement =>
  screen.getByRole('button', { name: `Remover ${titulo}` }).closest('li')!;

const titleField = (): HTMLElement => screen.getByLabelText('Título do trabalho');
const descriptionField = (): HTMLElement => screen.getByLabelText('Descrição (opcional)');
const imageField = (): HTMLElement => screen.getByLabelText('Imagem (URL)');
const linkField = (): HTMLElement => screen.getByLabelText('Link do trabalho (URL)');
type User = ReturnType<typeof userEvent.setup>;

/** Cola o texto no campo de uma vez: tecla a tecla, cada letra redesenha a tela e o teste arrasta. */
async function fill(user: User, field: HTMLElement, text: string): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

const addButton = (): HTMLElement => screen.getByRole('button', { name: 'Adicionar ao portfólio' });

let layout: MockInstance<() => DOMRect> | null = null;

/** O jsdom não tem layout: cada linha da lista ganha 40px de altura, uma a cada 50px. */
function fakeLayout(): void {
  layout = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const rows = Array.from(this.parentElement?.children ?? []);
    const top = this.tagName === 'LI' ? rows.indexOf(this) * 50 : 0;
    return {
      top,
      bottom: top + 40,
      height: 40,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
}

beforeEach(() => {
  lista = [item(1, 'Logo'), item(2, 'Site'), item(3, 'Cardápio'), item(4, 'Vitrine')];
  proximoId = 100;
  myPortfolio.mockReset();
  myPortfolio.mockImplementation(async () => lista);
  addPortfolioItem.mockReset();
  addPortfolioItem.mockImplementation(async (body: UpsertPortfolioItemRequest) => {
    const created = item(proximoId++, body.title, {
      description: body.description ?? null,
      imageUrl: body.imageUrl ?? null,
      externalUrl: body.externalUrl ?? null,
    });
    lista = [...lista, created];
    return created;
  });
  removePortfolioItem.mockReset();
  removePortfolioItem.mockImplementation(async (id: number) => {
    lista = lista.filter((i) => i.id !== id);
  });
  reorderPortfolio.mockReset();
  reorderPortfolio.mockImplementation(async (ids: number[]) => {
    lista = ids.map((id) => lista.find((i) => i.id === id)!);
    return lista;
  });
  uploadMedia.mockReset();
  uploadMedia.mockResolvedValue({ url: MEDIA });
  // Lacunas do jsdom que o foco das setas e o arraste por ponteiro usam.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  layout?.mockRestore();
  layout = null;
});

describe('portfólio: o que a lista mostra', () => {
  it('enquanto carrega mostra o esqueleto; depois, a contagem e os trabalhos na ordem gravada', async () => {
    render(wrap(<PortfolioCard />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.getByText('0 de 12 · aparece no seu perfil público')).toBeInTheDocument();

    expect(await screen.findByText('4 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);
    expect(
      screen.getByText(/O perfil público mostra os trabalhos nesta ordem\./),
    ).toHaveTextContent('Na alça: espaço pega, setas movem, espaço solta, Esc ou Tab cancela.');
  });

  it('sem trabalho nenhum, convida a mostrar o que já fez e não fala de ordem', async () => {
    lista = [];
    render(wrap(<PortfolioCard />));

    expect(
      await screen.findByText(
        'Mostre o que você já fez: uma imagem ou um link por trabalho. Clientes olham isso antes de contratar.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('0 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(screen.queryByText(/O perfil público mostra os trabalhos nesta ordem/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remover / })).not.toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it('com um trabalho só não há o que ordenar: sem alça e sem setas, só o remover', async () => {
    lista = [item(1, 'Logo')];
    render(wrap(<PortfolioCard />));

    expect(await screen.findByText('1 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover Logo' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reordenar Logo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mover Logo/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/O perfil público mostra os trabalhos nesta ordem/)).toBeNull();
  });

  it('cada linha mostra a descrição, o link (em outra aba) e a miniatura da imagem', async () => {
    lista = [
      item(1, 'Logo', {
        description: 'Marca da padaria do bairro',
        imageUrl: MEDIA,
        externalUrl: 'https://exemplo.test/logo',
      }),
      item(2, 'Site'),
    ];
    render(wrap(<PortfolioCard />));
    await screen.findByText('2 de 12 · aparece no seu perfil público');

    const logo = linha('Logo');
    expect(within(logo).getByText('Marca da padaria do bairro')).toBeInTheDocument();
    const link = within(logo).getByRole('link', { name: 'https://exemplo.test/logo' });
    expect(link).toHaveAttribute('href', 'https://exemplo.test/logo');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(logo.querySelector('img')).toHaveAttribute('src', `${MEDIA}?w=128`);

    const site = linha('Site');
    expect(within(site).queryByRole('link')).not.toBeInTheDocument();
    expect(site.querySelector('img')).toBeNull();
  });

  it('com 12 trabalhos o limite foi atingido e o formulário some', async () => {
    lista = Array.from({ length: 12 }, (_, i) => item(i + 1, `Trabalho ${i + 1}`));
    render(wrap(<PortfolioCard />));

    expect(await screen.findByText('12 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adicionar ao portfólio' })).toBeNull();
    expect(screen.queryByLabelText('Título do trabalho')).not.toBeInTheDocument();
    expect(titulos()).toHaveLength(12);
  });

  it('lista que não carrega mostra o erro e tenta de novo pelo botão', async () => {
    const user = userEvent.setup();
    myPortfolio.mockRejectedValueOnce(new Error('Não foi possível carregar o portfólio'));
    render(wrap(<PortfolioCard />));

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Não foi possível carregar o portfólio');

    await user.click(within(alerta).getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText('4 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(myPortfolio).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('portfólio: adicionar um trabalho', () => {
  it('o título é obrigatório, de 3 a 150 caracteres', async () => {
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    expect(titleField()).toBeRequired();
    expect(titleField()).toHaveAttribute('minlength', '3');
    expect(titleField()).toHaveAttribute('maxlength', '150');
    expect(descriptionField()).not.toBeRequired();
    expect(imageField()).not.toBeRequired();
    expect(linkField()).not.toBeRequired();
  });

  it('sem imagem e sem link, avisa e não chama a API', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await fill(user, titleField(), 'Cartão de visita');
    await fill(user, imageField(), '   ');
    await user.click(addButton());

    expect(await screen.findByText('Informe a imagem ou o link do trabalho')).toBeInTheDocument();
    expect(addPortfolioItem).not.toHaveBeenCalled();
    expect(titleField()).toHaveValue('Cartão de visita');
  });

  it('com link: manda os campos sem espaços nas pontas e os vazios como null, confirma, limpa e recarrega', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await fill(user, titleField(), '  Cartão de visita  ');
    await fill(user, linkField(), 'https://exemplo.test/cartao');
    await user.click(addButton());

    expect(await screen.findByText('Trabalho adicionado ao portfólio.')).toBeInTheDocument();
    expect(addPortfolioItem).toHaveBeenCalledTimes(1);
    expect(addPortfolioItem).toHaveBeenCalledWith({
      title: 'Cartão de visita',
      description: null,
      imageUrl: null,
      externalUrl: 'https://exemplo.test/cartao',
    });
    expect(titleField()).toHaveValue('');
    expect(linkField()).toHaveValue('');
    // A lista é lida de novo e o trabalho entra no fim.
    expect(await screen.findByText('5 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine', 'Cartão de visita']);
  });

  it('com descrição e endereço de imagem digitado: os dois vão para a API e a prévia aparece', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await fill(user, titleField(), 'Fachada');
    await fill(user, descriptionField(), ' Pintura da fachada ');
    expect(imageField().closest('label')!.querySelector('img')).toBeNull();
    await fill(user, imageField(), 'https://exemplo.test/fachada.jpg');
    // Endereço de fora do Escambo não tem miniatura: a prévia usa o próprio endereço.
    expect(imageField().closest('label')!.querySelector('img')).toHaveAttribute(
      'src',
      'https://exemplo.test/fachada.jpg',
    );
    await user.click(addButton());

    await waitFor(() =>
      expect(addPortfolioItem).toHaveBeenCalledWith({
        title: 'Fachada',
        description: 'Pintura da fachada',
        imageUrl: 'https://exemplo.test/fachada.jpg',
        externalUrl: null,
      }),
    );
    await waitFor(() => expect(imageField()).toHaveValue(''));
    expect(descriptionField()).toHaveValue('');
    expect(imageField().closest('label')!.querySelector('img')).toBeNull();
  });

  it('imagem enviada do aparelho: sobe como portfólio, preenche o endereço, mostra a prévia e vai no trabalho', async () => {
    const user = userEvent.setup();
    const file = new File(['png'], 'fachada.png', { type: 'image/png' });
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    // O campo de arquivo fica escondido atrás do botão "Enviar imagem": não tem papel nem nome.
    await user.upload(screen.getByTestId('portfolio-upload'), file);

    expect(await screen.findByText('Imagem enviada.')).toBeInTheDocument();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledWith(file, 'fachada.png', 'portfolio');
    expect(imageField()).toHaveValue(MEDIA);
    expect(imageField().closest('label')!.querySelector('img')).toHaveAttribute(
      'src',
      `${MEDIA}?w=128`,
    );

    await fill(user, titleField(), 'Fachada');
    await user.click(addButton());

    await waitFor(() =>
      expect(addPortfolioItem).toHaveBeenCalledWith({
        title: 'Fachada',
        description: null,
        imageUrl: MEDIA,
        externalUrl: null,
      }),
    );
    expect(await screen.findByText('Trabalho adicionado ao portfólio.')).toBeInTheDocument();
    // Na lista relida, o trabalho novo aparece com a miniatura da imagem enviada.
    expect(await screen.findByText('5 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(linha('Fachada').querySelector('img')).toHaveAttribute('src', `${MEDIA}?w=128`);
  });

  it('enquanto adiciona, o botão diz Adicionando… e não aceita outro envio', async () => {
    const user = userEvent.setup();
    let solta!: (v: PortfolioItem) => void;
    addPortfolioItem.mockImplementation(() => new Promise<PortfolioItem>((r) => (solta = r)));
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await fill(user, titleField(), 'Cartão de visita');
    await fill(user, linkField(), 'https://exemplo.test/cartao');
    await user.click(addButton());

    const adicionando = await screen.findByRole('button', { name: 'Adicionando…' });
    expect(adicionando).toBeDisabled();
    await user.click(adicionando);
    expect(addPortfolioItem).toHaveBeenCalledTimes(1);
    // Nada é confirmado nem limpo antes de a API responder.
    expect(screen.queryByText('Trabalho adicionado ao portfólio.')).not.toBeInTheDocument();
    expect(titleField()).toHaveValue('Cartão de visita');

    solta(item(100, 'Cartão de visita'));
    expect(await screen.findByText('Trabalho adicionado ao portfólio.')).toBeInTheDocument();
    await waitFor(() => expect(addButton()).toBeEnabled());
  });

  it('recusa da API: mostra a mensagem dela e mantém o que foi digitado', async () => {
    const user = userEvent.setup();
    addPortfolioItem.mockRejectedValue(new Error('O link do trabalho não é um endereço válido.'));
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await fill(user, titleField(), 'Cartão de visita');
    await fill(user, linkField(), 'https://exemplo.test/cartao');
    await user.click(addButton());

    expect(
      await screen.findByText('O link do trabalho não é um endereço válido.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Trabalho adicionado ao portfólio.')).not.toBeInTheDocument();
    expect(titleField()).toHaveValue('Cartão de visita');
    expect(linkField()).toHaveValue('https://exemplo.test/cartao');
    expect(myPortfolio).toHaveBeenCalledTimes(1);
  });

  it('falha sem mensagem ao adicionar cai no texto padrão', async () => {
    const user = userEvent.setup();
    addPortfolioItem.mockRejectedValue('sem rede');
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await fill(user, titleField(), 'Cartão de visita');
    await fill(user, linkField(), 'https://exemplo.test/cartao');
    await user.click(addButton());

    expect(await screen.findByText('Não foi possível adicionar')).toBeInTheDocument();
  });
});

describe('portfólio: remover um trabalho', () => {
  it('remove o trabalho daquela linha, confirma e recarrega a lista', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Remover Site' }));

    expect(await screen.findByText('Trabalho removido.')).toBeInTheDocument();
    expect(removePortfolioItem).toHaveBeenCalledTimes(1);
    expect(removePortfolioItem).toHaveBeenCalledWith(2);
    expect(await screen.findByText('3 de 12 · aparece no seu perfil público')).toBeInTheDocument();
    expect(titulos()).toEqual(['Logo', 'Cardápio', 'Vitrine']);
  });

  it('enquanto remove, nenhum outro remover aceita clique', async () => {
    const user = userEvent.setup();
    let solta!: () => void;
    removePortfolioItem.mockImplementation(() => new Promise<void>((r) => (solta = r)));
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Remover Site' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remover Logo' })).toBeDisabled(),
    );
    for (const b of screen.getAllByRole('button', { name: /^Remover / })) expect(b).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remover Logo' }));
    expect(removePortfolioItem).toHaveBeenCalledTimes(1);

    solta();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remover Logo' })).toBeEnabled());
  });

  it('recusa da API ao remover: mostra a mensagem dela e o trabalho continua na lista', async () => {
    const user = userEvent.setup();
    removePortfolioItem.mockRejectedValue(new Error('Trabalho não encontrado'));
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Remover Site' }));

    expect(await screen.findByText('Trabalho não encontrado')).toBeInTheDocument();
    expect(screen.queryByText('Trabalho removido.')).not.toBeInTheDocument();
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);
  });

  it('falha sem mensagem ao remover cai no texto padrão', async () => {
    const user = userEvent.setup();
    removePortfolioItem.mockRejectedValue('sem rede');
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Remover Site' }));

    expect(await screen.findByText('Não foi possível remover')).toBeInTheDocument();
  });
});

describe('portfólio: as setas de subir e descer', () => {
  it('descer grava a ordem nova uma vez, anuncia a posição e a tela acompanha', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Mover Logo para baixo' }));

    expect(reorderPortfolio).toHaveBeenCalledTimes(1);
    expect(reorderPortfolio).toHaveBeenCalledWith([2, 1, 3, 4]);
    expect(screen.getByText('Logo agora é o 2º de 4.')).toBeInTheDocument();
    await waitFor(() => expect(titulos()).toEqual(['Site', 'Logo', 'Cardápio', 'Vitrine']));
    // O foco fica no mesmo botão, para dar o passo seguinte sem procurar de novo.
    expect(screen.getByRole('button', { name: 'Mover Logo para baixo' })).toHaveFocus();
  });

  it('nas pontas a seta avisa que está desabilitada e clicar não grava nada', async () => {
    const user = userEvent.setup();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    const sobeOPrimeiro = screen.getByRole('button', { name: 'Mover Logo para cima' });
    const desceOUltimo = screen.getByRole('button', { name: 'Mover Vitrine para baixo' });
    expect(sobeOPrimeiro).toHaveAttribute('aria-disabled', 'true');
    expect(desceOUltimo).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Mover Logo para baixo' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Mover Site para cima' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );

    await user.click(sobeOPrimeiro);
    await user.click(desceOUltimo);

    expect(reorderPortfolio).not.toHaveBeenCalled();
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);
  });

  it('gravação recusada: mostra a mensagem da API e a ordem volta ao que estava', async () => {
    const user = userEvent.setup();
    reorderPortfolio.mockRejectedValue(new Error('Portfólio em revisão: a ordem não pode mudar.'));
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Mover Vitrine para cima' }));

    expect(
      await screen.findByText('Portfólio em revisão: a ordem não pode mudar.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']));
  });

  it('falha sem mensagem ao gravar a ordem cai no texto padrão', async () => {
    const user = userEvent.setup();
    reorderPortfolio.mockRejectedValue('sem rede');
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    await user.click(screen.getByRole('button', { name: 'Mover Vitrine para cima' }));

    expect(await screen.findByText('Não foi possível mudar a ordem')).toBeInTheDocument();
  });
});

describe('portfólio: arrastar pela alça com o ponteiro (ADR 49)', () => {
  const alca = (titulo: string): HTMLElement =>
    screen.getByRole('button', { name: `Reordenar ${titulo}` });

  it('soltar numa posição nova grava a ordem uma vez e anuncia onde o trabalho ficou', async () => {
    fakeLayout();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    // Vitrine é a 4ª linha (150 a 190px); subir 100px passa o meio da 3ª e da 2ª.
    fireEvent.pointerDown(alca('Vitrine'), {
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      clientY: 175,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 75 });
    // Enquanto o ponteiro não solta, nada é gravado.
    expect(reorderPortfolio).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 75 });

    await waitFor(() => expect(reorderPortfolio).toHaveBeenCalledTimes(1));
    expect(reorderPortfolio).toHaveBeenCalledWith([1, 4, 2, 3]);
    expect(screen.getByText('Vitrine agora é o 2º de 4.')).toBeInTheDocument();
    await waitFor(() => expect(titulos()).toEqual(['Logo', 'Vitrine', 'Site', 'Cardápio']));
  });

  it('soltar no mesmo lugar não grava nem anuncia', async () => {
    fakeLayout();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    fireEvent.pointerDown(alca('Vitrine'), {
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      clientY: 175,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 165 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 165 });

    expect(reorderPortfolio).not.toHaveBeenCalled();
    expect(screen.queryByText(/agora é o/)).not.toBeInTheDocument();
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);
  });

  it('Esc no meio do arraste devolve tudo ao lugar e soltar depois não grava', async () => {
    fakeLayout();
    render(wrap(<PortfolioCard />));
    await screen.findByText('4 de 12 · aparece no seu perfil público');

    fireEvent.pointerDown(alca('Vitrine'), {
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      clientY: 175,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 75 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 75 });

    expect(reorderPortfolio).not.toHaveBeenCalled();
    expect(titulos()).toEqual(['Logo', 'Site', 'Cardápio', 'Vitrine']);
  });
});
