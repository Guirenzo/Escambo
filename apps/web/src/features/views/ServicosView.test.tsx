import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Category, Favorite, Paginated, SavedSearch, Service } from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_SHORT } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { ServicosView } from './ServicosView';

/**
 * Busca de serviços: o que cada controle da tela manda para a API (texto, categoria, filtros,
 * proximidade, "atende agora"), os favoritos, as buscas salvas, a paginação e a publicação de um
 * serviço novo.
 */

// A tela inteira é renderizada a cada tecla: com a suíte toda em paralelo, 5 s ficam curtos.
vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  categories: vi.fn(),
  favorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  publicSettings: vi.fn(),
  createService: vi.fn(),
  savedSearches: vi.fn(),
  createSavedSearch: vi.fn(),
  wallet: vi.fn(),
  boostPlans: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

interface Viewer {
  id: number;
  role: 'client' | 'freelancer';
  timezone: string;
  digestHour: number;
}
const auth = vi.hoisted(() => ({ user: null as Viewer | null }));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const ME = 3;
const PAGE = { page: 1, limit: 12 };

const service = (o: Partial<Service> = {}): Service => ({
  id: 11,
  categoryId: 2,
  ownerId: 7,
  title: 'Identidade visual',
  description: 'Logo, paleta e manual de uso.',
  priceType: 'fixed',
  price: 800,
  deliveryDays: 10,
  isRemote: true,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  ownerUlid: 'u-marina',
  ownerName: 'Marina Alves',
  ownerRating: 4.8,
  ownerReviews: 12,
  ...o,
});

const pageOf = (items: Service[], page = 1): Paginated<Service> => ({ items, page, limit: 12 });

const categories: Category[] = [
  {
    id: 1,
    parentId: null,
    name: 'Design',
    slug: 'design',
    iconUrl: null,
    children: [{ id: 2, parentId: 1, name: 'Logos', slug: 'logos', iconUrl: null, children: [] }],
  },
  { id: 3, parentId: null, name: 'Programação', slug: 'programacao', iconUrl: null, children: [] },
];

const favorite = (targetType: Favorite['targetType'], targetId: number): Favorite => ({
  id: targetId * 10 + (targetType === 'service' ? 1 : 2),
  targetType,
  targetId,
  createdAt: '2026-10-01T12:00:00.000Z',
});

const saved = (o: Partial<SavedSearch> = {}): SavedSearch => ({
  id: 5,
  name: 'Logos baratos',
  query: 'logo',
  filters: {
    categoryId: 2,
    lat: -26.3,
    lng: -48.8,
    radiusKm: 50,
    minPrice: 50,
    maxPrice: 300,
    maxDeliveryDays: 7,
    minRating: 4,
    day: 1,
    period: 'morning',
  },
  alertEnabled: true,
  alertFrequency: 'hourly',
  lastAlertAt: null,
  createdAt: '2026-09-15T12:00:00.000Z',
  ...o,
});

/** A rota em que o app está: muda no "propor troca" e é limpa depois do link do alerta. */
function Where() {
  const l = useLocation();
  return <p data-testid="rota">{l.pathname + l.search}</p>;
}
/** A navegação do roteador é uma transição: a rota nova pode chegar um instante depois do clique. */
const expectRoute = (path: string) =>
  waitFor(() => expect(screen.getByTestId('rota').textContent).toBe(path));

function renderView(entry = '/servicos') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              path="/servicos"
              element={
                <>
                  <ServicosView />
                  <Where />
                </>
              }
            />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Renderiza e espera a primeira lista chegar. */
async function openView(entry?: string) {
  const view = renderView(entry);
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Carregando' })).toBeNull());
  return view;
}

/** O último pedido de busca que a tela fez à API. */
const expectQuery = (query: Record<string, unknown>) =>
  waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith({ ...query, ...PAGE }));

const searchInput = (): HTMLElement => screen.getByPlaceholderText('Buscar serviços…');
const combo = (name: string): HTMLElement => screen.getByRole('combobox', { name });
const optionsOf = (name: string): string[] =>
  within(combo(name))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');

type Locate = (
  ok: (pos: { coords: { latitude: number; longitude: number } }) => void,
  fail: () => void,
  options: { timeout: number },
) => void;
const stubGeolocation = (getCurrentPosition: Locate): void => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  });
};
const HERE = { coords: { latitude: -26.3045, longitude: -48.8487 } };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  auth.user = { id: ME, role: 'client', timezone: 'America/Sao_Paulo', digestHour: 8 };
  api.listServices.mockResolvedValue(pageOf([service()]));
  api.categories.mockResolvedValue(categories);
  api.favorites.mockResolvedValue([]);
  api.addFavorite.mockResolvedValue(undefined);
  api.removeFavorite.mockResolvedValue(undefined);
  api.publicSettings.mockResolvedValue({
    minServicePrice: 10,
    barterEnabled: true,
    platformFeePercentage: 15,
  });
  api.createService.mockResolvedValue(service({ id: 99 }));
  api.savedSearches.mockResolvedValue([]);
  api.createSavedSearch.mockResolvedValue(saved());
  api.wallet.mockResolvedValue({ balance: 1000, balancePending: 0, credits: 50 });
  api.boostPlans.mockResolvedValue([]);
});

afterEach(() => {
  delete (navigator as { geolocation?: unknown }).geolocation;
});

describe('ServicosView: carregamento da lista', () => {
  it('enquanto a busca não volta, mostra o esqueleto no lugar da lista', () => {
    api.listServices.mockReturnValue(new Promise(() => undefined));
    renderView();
    expect(screen.getByRole('heading', { level: 1, name: 'Serviços' })).toBeVisible();
    expect(screen.getByText('Encontre quem faz — ou publique o que você faz.')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(api.listServices).toHaveBeenCalledWith(PAGE);
    expect(document.title).toBe('Serviços · Escambo');
  });

  it('busca que falha: mostra o erro e "Tentar de novo" refaz a mesma busca', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices.mockRejectedValueOnce(new Error('Busca indisponível'));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Busca indisponível');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Identidade visual')).toBeVisible();
    expect(api.listServices).toHaveBeenCalledTimes(2);
    expect(api.listServices).toHaveBeenLastCalledWith(PAGE);
  });

  it('sem nenhum serviço, diz que nada foi encontrado', async () => {
    api.listServices.mockResolvedValue(pageOf([]));
    await openView();
    expect(screen.getByText('Nenhum serviço encontrado.')).toBeVisible();
  });

  it('cada serviço mostra título, descrição, preço e o link para o perfil de quem presta', async () => {
    api.listServices.mockResolvedValue(
      pageOf([service(), service({ id: 12, title: 'Site institucional', price: null })]),
    );
    await openView();
    expect(screen.getByText('Identidade visual')).toBeVisible();
    expect(screen.getAllByText('Logo, paleta e manual de uso.')).toHaveLength(2);
    expect(screen.getByText('R$ 800,00')).toBeVisible();
    expect(screen.getByText('a combinar')).toBeVisible();
    for (const link of screen.getAllByRole('link', { name: 'Marina Alves' })) {
      expect(link).toHaveAttribute('href', '/freelancers/u-marina');
    }
  });
});

describe('ServicosView: busca por texto e categoria', () => {
  it('só busca ao enviar, com o texto sem espaços nas pontas; texto vazio volta à busca geral', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.type(searchInput(), '  logo ');
    // Digitar não dispara busca: só o "Buscar".
    expect(api.listServices).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await expectQuery({ q: 'logo' });

    await user.clear(searchInput());
    await user.type(searchInput(), '   {Enter}');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
    expect(api.listServices.mock.lastCall![0].q).toBeUndefined();
  });

  it('lista as categorias com as filhas recuadas e filtra pela escolhida', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await waitFor(() =>
      expect(optionsOf('Categoria')).toEqual([
        'Todas as categorias',
        'Design',
        '— Logos',
        'Programação',
      ]),
    );
    await user.selectOptions(combo('Categoria'), '— Logos');
    await expectQuery({ categoryId: 2 });

    await user.selectOptions(combo('Categoria'), 'Todas as categorias');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
  });
});

describe('ServicosView: filtros e ordenação', () => {
  it('cada filtro entra na busca na hora, sem precisar enviar', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.type(screen.getByRole('spinbutton', { name: 'Preço mínimo' }), '50');
    await expectQuery({ minPrice: 50 });
    await user.type(screen.getByRole('spinbutton', { name: 'Preço máximo' }), '500');
    await user.selectOptions(combo('Prazo máximo'), 'até 7 dias');
    await user.selectOptions(combo('Nota mínima'), '4.5+ estrelas');
    await user.selectOptions(combo('Atende no dia'), '1');
    await user.selectOptions(combo('Período do dia'), 'tarde');
    await user.selectOptions(combo('Ordenar por'), 'Menor preço');

    await expectQuery({
      minPrice: 50,
      maxPrice: 500,
      maxDeliveryDays: 7,
      minRating: 4.5,
      day: 1,
      period: 'afternoon',
      sort: 'price_asc',
    });
  });

  it('as opções de prazo, nota, período e ordenação são as que a busca aceita', async () => {
    await openView();
    expect(optionsOf('Prazo máximo')).toEqual([
      'qualquer',
      'até 3 dias',
      'até 7 dias',
      'até 15 dias',
      'até 30 dias',
    ]);
    expect(optionsOf('Nota mínima')).toEqual([
      'qualquer',
      '3+ estrelas',
      '4+ estrelas',
      '4.5+ estrelas',
    ]);
    expect(optionsOf('Período do dia')).toEqual(['qualquer período', 'manhã', 'tarde', 'noite']);
    // "Mais perto" só existe com a localização ligada.
    expect(optionsOf('Ordenar por')).toEqual([
      'Relevância',
      'Menor preço',
      'Maior preço',
      'Melhor avaliados',
      'Mais recentes',
    ]);
  });

  it('o dia de hoje vem marcado com "(hoje)" na lista de dias', async () => {
    await openView();
    const today = new Date().getDay();
    const expected = [
      'qualquer dia',
      ...WEEKDAY_SHORT.map((label, d) => (d === today ? `${label} (hoje)` : label)),
    ];
    expect(optionsOf('Atende no dia')).toEqual(expected);
  });

  it('o período só pode ser escolhido depois do dia, e voltar a "qualquer dia" o desfaz', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    expect(combo('Período do dia')).toBeDisabled();
    expect(combo('Período do dia')).toHaveAttribute('title', 'Escolha o dia primeiro');

    await user.selectOptions(combo('Atende no dia'), '6');
    expect(combo('Período do dia')).toBeEnabled();
    await user.selectOptions(combo('Período do dia'), 'noite');
    await expectQuery({ day: 6, period: 'evening' });

    await user.selectOptions(combo('Atende no dia'), 'qualquer dia');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
    expect(combo('Período do dia')).toBeDisabled();
    expect(combo('Período do dia')).toHaveValue('');
  });

  it('"Limpar filtros" só aparece com filtro ligado e devolve tudo ao padrão', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();

    await user.type(screen.getByRole('spinbutton', { name: 'Preço máximo' }), '90');
    await user.selectOptions(combo('Ordenar por'), 'Mais recentes');
    await expectQuery({ maxPrice: 90, sort: 'newest' });

    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
    expect(screen.getByRole('spinbutton', { name: 'Preço máximo' })).toHaveValue(null);
    expect(combo('Ordenar por')).toHaveValue('relevance');
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
  });

  it('qualquer filtro sozinho, e também a ordenação, já oferece "Limpar filtros"', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    const clear = () => screen.queryByRole('button', { name: 'Limpar filtros' });
    const steps: [string, () => Promise<void>][] = [
      [
        'preço mínimo',
        () => user.type(screen.getByRole('spinbutton', { name: 'Preço mínimo' }), '1'),
      ],
      [
        'preço máximo',
        () => user.type(screen.getByRole('spinbutton', { name: 'Preço máximo' }), '1'),
      ],
      ['prazo', () => user.selectOptions(combo('Prazo máximo'), 'até 3 dias')],
      ['nota', () => user.selectOptions(combo('Nota mínima'), '3+ estrelas')],
      ['dia', () => user.selectOptions(combo('Atende no dia'), '0')],
      ['atende agora', () => user.click(screen.getByRole('button', { name: 'Atende agora' }))],
      ['ordenação', () => user.selectOptions(combo('Ordenar por'), 'Maior preço')],
    ];
    for (const [name, apply] of steps) {
      expect(clear(), `antes de ${name}`).toBeNull();
      await apply();
      expect(clear(), `depois de ${name}`).toBeVisible();
      await user.click(clear()!);
    }
    expect(clear()).toBeNull();
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
  });

  it('lista vazia com filtro ligado sugere afrouxar os filtros', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices.mockResolvedValue(pageOf([]));
    await openView();
    await user.selectOptions(combo('Nota mínima'), '4+ estrelas');
    expect(
      await screen.findByText(
        'Nenhum serviço com esses filtros — afrouxe o preço, o prazo ou a nota.',
      ),
    ).toBeVisible();
    await expectQuery({ minRating: 4 });
  });

  it('"Atende agora" liga e desliga o filtro de quem está atendendo neste momento', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    const toggle = screen.getByRole('button', { name: 'Atende agora' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expectQuery({ now: true });
    // Conta como filtro: dá para limpar.
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
  });
});

describe('ServicosView: perto de mim', () => {
  it('navegador sem geolocalização: avisa e a busca não muda', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.click(screen.getByRole('button', { name: 'Perto de mim' }));
    expect(await screen.findByText('Seu navegador não oferece geolocalização')).toBeVisible();
    expect(api.listServices).toHaveBeenCalledTimes(1);
  });

  it('pede a posição com limite de 8 s e, com ela, busca num raio de 25 km', async () => {
    const user = userEvent.setup({ delay: null });
    const locate = vi.fn<Locate>();
    stubGeolocation(locate);
    await openView();
    await user.click(screen.getByRole('button', { name: 'Perto de mim' }));
    expect(locate).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      timeout: 8000,
    });
    expect(screen.getByRole('button', { name: 'Localizando…' })).toBeDisabled();

    act(() => locate.mock.calls[0]![0](HERE));
    expect(screen.getByRole('button', { name: 'Perto de mim: ativo' })).toBeEnabled();
    await expectQuery({ lat: -26.3045, lng: -48.8487, radiusKm: 25 });
    expect(screen.getByText('ordenado por proximidade')).toBeVisible();
    expect(optionsOf('Raio em km')).toEqual(['5 km', '10 km', '25 km', '50 km', '100 km']);
    expect(combo('Raio em km')).toHaveValue('25');
  });

  it('com a localização ligada: muda o raio, ganha "Mais perto" e o vazio sugere aumentar o raio', async () => {
    const user = userEvent.setup({ delay: null });
    stubGeolocation((ok) => ok(HERE));
    api.listServices.mockResolvedValue(pageOf([]));
    await openView();
    await user.click(screen.getByRole('button', { name: 'Perto de mim' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Raio em km' }), '50 km');
    await expectQuery({ lat: -26.3045, lng: -48.8487, radiusKm: 50 });
    expect(
      await screen.findByText('Nenhum serviço num raio de 50 km — aumente o raio.'),
    ).toBeVisible();

    expect(optionsOf('Ordenar por')).toContain('Mais perto');
    await user.selectOptions(combo('Ordenar por'), 'Mais perto');
    await expectQuery({ lat: -26.3045, lng: -48.8487, radiusKm: 50, sort: 'distance' });
    // Com ordenação escolhida, a nota "ordenado por proximidade" sai.
    expect(screen.queryByText('ordenado por proximidade')).toBeNull();
  });

  it('clicar de novo desliga a localização e a busca volta a ser geral', async () => {
    const user = userEvent.setup({ delay: null });
    stubGeolocation((ok) => ok(HERE));
    await openView();
    await user.click(screen.getByRole('button', { name: 'Perto de mim' }));
    await expectQuery({ lat: -26.3045, lng: -48.8487, radiusKm: 25 });

    await user.click(screen.getByRole('button', { name: 'Perto de mim: ativo' }));
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith(PAGE));
    expect(screen.getByRole('button', { name: 'Perto de mim' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Raio em km' })).toBeNull();
  });

  it('posição negada: avisa e libera o botão de novo', async () => {
    const user = userEvent.setup({ delay: null });
    stubGeolocation((_ok, fail) => fail());
    await openView();
    await user.click(screen.getByRole('button', { name: 'Perto de mim' }));
    expect(await screen.findByText('Não consegui obter sua localização')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Perto de mim' })).toBeEnabled();
    expect(api.listServices).toHaveBeenCalledTimes(1);
  });
});

describe('ServicosView: favoritos', () => {
  beforeEach(() => {
    api.listServices.mockResolvedValue(
      pageOf([service({ id: 11 }), service({ id: 12, title: 'Site institucional' })]),
    );
  });

  it('o coração favorita o serviço que não é favorito e desfaz o que já é', async () => {
    const user = userEvent.setup({ delay: null });
    // Favorito de freelancer com o mesmo número não conta como favorito do serviço.
    api.favorites.mockResolvedValue([favorite('service', 11), favorite('freelancer', 12)]);
    await openView();
    expect(await screen.findByRole('button', { name: 'Só favoritos (1)' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Favoritar', pressed: false }));
    expect(api.addFavorite).toHaveBeenCalledWith({ targetType: 'service', targetId: 12 });

    await user.click(screen.getByRole('button', { name: 'Remover dos favoritos', pressed: true }));
    expect(api.removeFavorite).toHaveBeenCalledWith('service', 11);
  });

  it('depois de favoritar, os favoritos são buscados de novo e o coração e a contagem mudam', async () => {
    const user = userEvent.setup({ delay: null });
    api.favorites
      .mockResolvedValueOnce([favorite('service', 11)])
      .mockResolvedValue([favorite('service', 11), favorite('service', 12)]);
    await openView();
    await screen.findByRole('button', { name: 'Só favoritos (1)' });
    await user.click(screen.getByRole('button', { name: 'Favoritar', pressed: false }));

    expect(await screen.findByRole('button', { name: 'Só favoritos (2)' })).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: 'Remover dos favoritos', pressed: true }),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Favoritar' })).toBeNull();
  });

  it.todo(
    'favoritar recusado pela API mostra o motivo (defeito: ServicosView.tsx:538 chama toggleFav.mutate sem onError e useToggleFavorite não avisa: a falha é silenciosa)',
  );

  it('"Só favoritos" deixa na lista apenas os serviços favoritados', async () => {
    const user = userEvent.setup({ delay: null });
    api.favorites.mockResolvedValue([favorite('service', 12)]);
    await openView();
    const toggle = await screen.findByRole('button', { name: 'Só favoritos (1)' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Site institucional')).toBeVisible();
    expect(screen.queryByText('Identidade visual')).toBeNull();

    await user.click(toggle);
    expect(screen.getByText('Identidade visual')).toBeVisible();
  });

  it('"Só favoritos" sem nenhum favorito na lista explica como favoritar', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.click(screen.getByRole('button', { name: 'Só favoritos' }));
    expect(
      screen.getByText('Nenhum favorito nesta lista. Marque o coração nos serviços.'),
    ).toBeVisible();
  });

  it('o próprio serviço não tem coração nem "Contratar": tem "Impulsionar"', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices.mockResolvedValue(pageOf([service({ id: 11, ownerId: ME })]));
    await openView();
    expect(screen.queryByRole('button', { name: 'Favoritar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Contratar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Impulsionar' }));
    const dialog = screen.getByRole('dialog', { name: 'Impulsionar: Identidade visual' });
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ServicosView: contratar e propor troca', () => {
  it('"Contratar" abre o modal de contratação do serviço escolhido e dá para fechar', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices.mockResolvedValue(
      pageOf([service({ id: 11 }), service({ id: 12, title: 'Site institucional' })]),
    );
    await openView();
    await user.click(screen.getAllByRole('button', { name: 'Contratar' })[1]!);
    const dialog = screen.getByRole('dialog', { name: 'Contratar: Site institucional' });
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cliente não vê "Propor troca"; freelancer é levado às trocas com o serviço escolhido', async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = await openView();
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propor troca' })).toBeNull();
    unmount();

    auth.user = { id: ME, role: 'freelancer', timezone: 'America/Sao_Paulo', digestHour: 8 };
    await openView();
    await user.click(await screen.findByRole('button', { name: 'Propor troca' }));
    await expectRoute('/trocas?propor=11');
  });
});

describe('ServicosView: carregar mais', () => {
  const full = Array.from({ length: 12 }, (_, i) =>
    service({ id: i + 1, title: `Serviço ${i + 1}` }),
  );

  it('página cheia oferece "Carregar mais", que pede a página seguinte e soma à lista', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices.mockImplementation(async (q: { page: number }) =>
      q.page === 1 ? pageOf(full, 1) : pageOf([service({ id: 13, title: 'Serviço 13' })], q.page),
    );
    await openView();
    expect(screen.getAllByRole('button', { name: 'Contratar' })).toHaveLength(12);
    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));

    expect(await screen.findByText('Serviço 13')).toBeVisible();
    expect(api.listServices).toHaveBeenLastCalledWith({ page: 2, limit: 12 });
    expect(screen.getByText('Serviço 1')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Contratar' })).toHaveLength(13);
    // A segunda página veio incompleta: acabou.
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('enquanto a próxima página não chega, o botão fica desabilitado dizendo "Carregando…"', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (p: Paginated<Service>) => void = () => undefined;
    api.listServices.mockImplementation((q: { page: number }) =>
      q.page === 1
        ? Promise.resolve(pageOf(full, 1))
        : new Promise<Paginated<Service>>((resolve) => {
            finish = resolve;
          }),
    );
    await openView();
    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('button', { name: 'Carregando…' })).toBeDisabled();
    await act(async () => finish(pageOf([], 2)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Carregando…' })).toBeNull());
  });

  it('página incompleta não oferece "Carregar mais"; em "Só favoritos" o botão também some', async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = await openView();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    unmount();

    api.listServices.mockResolvedValue(pageOf(full));
    api.favorites.mockResolvedValue([favorite('service', 1)]);
    await openView();
    expect(screen.getByRole('button', { name: 'Carregar mais' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Só favoritos (1)' }));
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });
});

describe('ServicosView: novo serviço', () => {
  const form = () => within(screen.getByRole('heading', { name: 'Novo serviço' }).closest('form')!);

  it('o botão do topo abre e fecha o formulário', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    expect(screen.queryByRole('heading', { name: 'Novo serviço' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    expect(screen.getByRole('heading', { name: 'Novo serviço' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('heading', { name: 'Novo serviço' })).toBeNull();
  });

  it('publica com a categoria escolhida, preço fixo e remoto; depois fecha e limpa o formulário', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices
      .mockResolvedValueOnce(pageOf([service()]))
      .mockResolvedValue(pageOf([service({ id: 99, title: 'Logo para padaria' }), service()]));
    await openView();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    await user.type(form().getByLabelText('Título'), 'Logo para padaria');
    await user.selectOptions(form().getByLabelText('Categoria'), '— Logos');
    await user.type(form().getByLabelText('Descrição'), 'Logo simples em vetor.');
    await user.type(form().getByLabelText('Preço (R$) · mínimo R$ 10,00'), '150.5');
    await user.click(form().getByRole('button', { name: 'Publicar' }));

    expect(api.createService).toHaveBeenCalledWith({
      categoryId: 2,
      title: 'Logo para padaria',
      description: 'Logo simples em vetor.',
      priceType: 'fixed',
      price: 150.5,
      isRemote: true,
    });
    expect(await screen.findByText('Serviço publicado!')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Novo serviço' })).toBeNull();
    // A lista é buscada de novo e o serviço novo aparece nela.
    expect(await screen.findByText('Logo para padaria')).toBeVisible();
    expect(api.listServices).toHaveBeenCalledTimes(2);
    expect(api.listServices).toHaveBeenLastCalledWith(PAGE);

    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    expect(form().getByLabelText('Título')).toHaveValue('');
    expect(form().getByLabelText('Descrição')).toHaveValue('');
    expect(form().getByLabelText('Preço (R$) · mínimo R$ 10,00')).toHaveValue(null);
  });

  it('sem escolher categoria, vai a primeira da lista', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    await waitFor(() => expect(form().getByLabelText('Categoria')).toHaveValue('1'));
    await user.type(form().getByLabelText('Título'), 'Cartão de visita');
    await user.type(form().getByLabelText('Descrição'), 'Frente e verso, pronto para gráfica.');
    await user.type(form().getByLabelText('Preço (R$) · mínimo R$ 10,00'), '80');
    await user.click(form().getByRole('button', { name: 'Publicar' }));
    expect(api.createService).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 1, price: 80 }),
    );
  });

  it('o preço mínimo do formulário é o que a plataforma pratica agora', async () => {
    const user = userEvent.setup({ delay: null });
    api.publicSettings.mockResolvedValue({ minServicePrice: 25, barterEnabled: true });
    await openView();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    const price = await form().findByLabelText('Preço (R$) · mínimo R$ 25,00');
    expect(price).toHaveAttribute('min', '25');
  });

  it('campos obrigatórios em branco: nada é enviado', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    await user.click(form().getByRole('button', { name: 'Publicar' }));
    expect(api.createService).not.toHaveBeenCalled();
    expect(form().getByLabelText('Título')).toBeRequired();
    expect(form().getByLabelText('Descrição')).toBeRequired();
  });

  it('recusa da API: mostra o motivo e o formulário continua aberto com o que foi digitado', async () => {
    const user = userEvent.setup({ delay: null });
    api.createService.mockRejectedValue(new Error('Complete seu perfil de freelancer antes.'));
    await openView();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    await user.type(form().getByLabelText('Título'), 'Logo para padaria');
    await user.type(form().getByLabelText('Descrição'), 'Logo simples em vetor.');
    await user.type(form().getByLabelText('Preço (R$) · mínimo R$ 10,00'), '150');
    await user.click(form().getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('Complete seu perfil de freelancer antes.')).toBeVisible();
    expect(form().getByLabelText('Título')).toHaveValue('Logo para padaria');
    expect(screen.queryByText('Serviço publicado!')).toBeNull();
  });

  it('enquanto publica, o botão fica desabilitado dizendo "Salvando…"', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (s: Service) => void = () => undefined;
    api.createService.mockReturnValue(
      new Promise<Service>((resolve) => {
        finish = resolve;
      }),
    );
    await openView();
    await user.click(screen.getByRole('button', { name: 'Novo serviço' }));
    await user.type(form().getByLabelText('Título'), 'Logo para padaria');
    await user.type(form().getByLabelText('Descrição'), 'Logo simples em vetor.');
    await user.type(form().getByLabelText('Preço (R$) · mínimo R$ 10,00'), '150');
    await user.click(form().getByRole('button', { name: 'Publicar' }));
    expect(await form().findByRole('button', { name: 'Salvando…' })).toBeDisabled();
    await act(async () => finish(service({ id: 99 })));
    expect(await screen.findByText('Serviço publicado!')).toBeVisible();
  });
});

describe('ServicosView: buscas salvas', () => {
  it('aplicar uma busca salva devolve texto, categoria, localização e filtros como foram salvos', async () => {
    const user = userEvent.setup({ delay: null });
    api.savedSearches.mockResolvedValue([saved()]);
    api.favorites.mockResolvedValue([favorite('service', 11)]);
    await openView();
    // O que estava ligado antes (favoritos, "atende agora", ordenação) é desfeito ao aplicar.
    await user.click(await screen.findByRole('button', { name: 'Só favoritos (1)' }));
    await user.click(screen.getByRole('button', { name: 'Atende agora' }));
    await user.selectOptions(combo('Ordenar por'), 'Mais recentes');

    const bar = await screen.findByRole('group', { name: 'Buscas salvas' });
    await user.click(within(bar).getByRole('button', { name: 'Logos baratos' }));

    await expectQuery({
      q: 'logo',
      categoryId: 2,
      lat: -26.3,
      lng: -48.8,
      radiusKm: 50,
      minPrice: 50,
      maxPrice: 300,
      maxDeliveryDays: 7,
      minRating: 4,
      day: 1,
      period: 'morning',
    });
    expect(searchInput()).toHaveValue('logo');
    expect(combo('Categoria')).toHaveValue('2');
    expect(screen.getByRole('spinbutton', { name: 'Preço mínimo' })).toHaveValue(50);
    expect(screen.getByRole('spinbutton', { name: 'Preço máximo' })).toHaveValue(300);
    expect(combo('Prazo máximo')).toHaveValue('7');
    expect(combo('Nota mínima')).toHaveValue('4');
    expect(combo('Atende no dia')).toHaveValue('1');
    expect(combo('Período do dia')).toHaveValue('morning');
    expect(combo('Raio em km')).toHaveValue('50');
    expect(screen.getByRole('button', { name: 'Perto de mim: ativo' })).toBeVisible();
    expect(combo('Ordenar por')).toHaveValue('relevance');
    expect(screen.getByRole('button', { name: 'Atende agora' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Só favoritos (1)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('busca salva só com texto limpa os filtros que estavam na tela', async () => {
    const user = userEvent.setup({ delay: null });
    api.savedSearches.mockResolvedValue([saved({ name: null, query: 'site', filters: null })]);
    await openView();
    await user.selectOptions(combo('Categoria'), 'Programação');
    await user.type(screen.getByRole('spinbutton', { name: 'Preço mínimo' }), '70');
    await expectQuery({ categoryId: 3, minPrice: 70 });

    // Sem nome, a busca salva aparece pelo texto buscado.
    await user.click(
      within(screen.getByRole('group', { name: 'Buscas salvas' })).getByRole('button', {
        name: 'site',
      }),
    );
    await expectQuery({ q: 'site' });
    expect(combo('Categoria')).toHaveValue('0');
    expect(screen.getByRole('spinbutton', { name: 'Preço mínimo' })).toHaveValue(null);
    expect(combo('Período do dia')).toBeDisabled();
  });

  it('link do alerta (?busca=ID) aplica a busca salva e limpa o endereço', async () => {
    api.savedSearches.mockResolvedValue([
      saved({ id: 5, query: 'logo', filters: { minPrice: 50 } }),
    ]);
    await openView('/servicos?busca=5');
    await expectQuery({ q: 'logo', minPrice: 50 });
    expect(searchInput()).toHaveValue('logo');
    await expectRoute('/servicos');
  });

  it('link de uma busca salva que não existe mais: avisa e limpa o endereço', async () => {
    api.savedSearches.mockResolvedValue([saved({ id: 5 })]);
    await openView('/servicos?busca=99');
    expect(await screen.findByText('Essa busca salva não existe mais.')).toBeVisible();
    await expectRoute('/servicos');
    expect(searchInput()).toHaveValue('');
    expect(api.listServices).toHaveBeenLastCalledWith(PAGE);
  });

  it('"Salvar busca" só libera com algo para salvar, e não em "Só favoritos"', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    const save = screen.getByRole('button', { name: 'Salvar busca' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Busque um texto ou escolha um filtro para salvar');

    await user.selectOptions(combo('Nota mínima'), '3+ estrelas');
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Só favoritos' }));
    expect(save).toBeDisabled();
  });

  it('salva a busca que a lista está mostrando: texto e filtros, sem a ordenação', async () => {
    const user = userEvent.setup({ delay: null });
    stubGeolocation((ok) => ok(HERE));
    await openView();
    await user.type(searchInput(), 'logo{Enter}');
    await user.selectOptions(combo('Categoria'), '— Logos');
    await user.click(screen.getByRole('button', { name: 'Perto de mim' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Raio em km' }), '10 km');
    await user.type(screen.getByRole('spinbutton', { name: 'Preço mínimo' }), '50');
    await user.type(screen.getByRole('spinbutton', { name: 'Preço máximo' }), '300');
    await user.selectOptions(combo('Prazo máximo'), 'até 15 dias');
    await user.selectOptions(combo('Nota mínima'), '4+ estrelas');
    await user.selectOptions(combo('Atende no dia'), '5');
    await user.selectOptions(combo('Período do dia'), 'manhã');
    await user.selectOptions(combo('Ordenar por'), 'Melhor avaliados');
    await user.click(screen.getByRole('button', { name: 'Atende agora' }));

    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    const dialog = screen.getByRole('dialog', { name: 'Salvar busca' });
    expect(within(dialog).getByText('“logo” · 10 filtros')).toBeVisible();
    expect(within(dialog).getByLabelText('Nome')).toHaveValue('logo');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(api.createSavedSearch).toHaveBeenCalledWith({
      name: 'logo',
      query: 'logo',
      filters: {
        categoryId: 2,
        lat: -26.3045,
        lng: -48.8487,
        radiusKm: 10,
        minPrice: 50,
        maxPrice: 300,
        maxDeliveryDays: 15,
        minRating: 4,
        day: 5,
        period: 'morning',
      },
      alertEnabled: true,
      alertFrequency: 'hourly',
    });
    expect(
      await screen.findByText(
        'Busca salva. Avisamos no máximo uma vez por hora quando aparecer serviço novo.',
      ),
    ).toBeVisible();
  });

  it('busca só com filtro é salva sem texto', async () => {
    const user = userEvent.setup({ delay: null });
    await openView();
    await user.selectOptions(combo('Prazo máximo'), 'até 3 dias');
    await user.click(screen.getByRole('button', { name: 'Salvar busca' }));
    const dialog = screen.getByRole('dialog', { name: 'Salvar busca' });
    expect(within(dialog).getByText('1 filtro')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(api.createSavedSearch).toHaveBeenCalledWith({
      name: null,
      query: null,
      filters: { maxDeliveryDays: 3 },
      alertEnabled: true,
      alertFrequency: 'hourly',
    });
  });
});
