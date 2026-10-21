import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Category, Service } from '@escambo/types';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEARBY_KM, searchPath, Showcase, SHOWCASE_LIMIT, type ShowcaseFilter } from './Showcase';

/**
 * Vitrine da página inicial: serviços reais filtrados pela busca do topo, ordenados por distância
 * só depois que a pessoa pede (a localização não é gravada). Sem resultado, estado vazio com saída;
 * erro, o aviso e o "tentar de novo". Nunca número que não veio da API.
 */

const api = vi.hoisted(() => ({ listServices: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../../lib/hooks', () => ({ usePublicSettings: () => ({ data: undefined }) }));

const CATALOG: Category[] = [
  {
    id: 2,
    parentId: null,
    name: 'Design',
    slug: 'design',
    iconUrl: null,
    children: [
      {
        id: 13,
        parentId: 2,
        name: 'Identidade Visual',
        slug: 'identidade-visual',
        iconUrl: null,
        children: [],
      },
    ],
  },
];

const service = (id: number, o: Partial<Service> = {}): Service => ({
  id,
  categoryId: 13,
  ownerId: 9,
  title: `Serviço ${id}`,
  description: 'Descrição.',
  priceType: 'fixed',
  price: 300,
  deliveryDays: 3,
  isRemote: true,
  isActive: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  ownerUlid: '01MARINA',
  ownerName: 'Marina Alves',
  ownerAvatarUrl: null,
  ownerRating: 4,
  ownerReviews: 1,
  ...o,
});

const pageOf = (items: Service[]) => ({ items, page: 1, limit: SHOWCASE_LIMIT });

type Locate = (
  ok: (pos: { coords: { latitude: number; longitude: number } }) => void,
  fail: () => void,
) => void;
const realGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
function stubGeolocation(getCurrentPosition: Locate | null): void {
  if (getCurrentPosition === null) {
    // Navegador sem a API: a propriedade nem existe.
    delete (navigator as unknown as Record<string, unknown>).geolocation;
    return;
  }
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  });
}

const onClearQuery = vi.fn();
const onClearCategory = vi.fn();

function renderShowcase(filter: ShowcaseFilter = { q: '', categoryId: null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Showcase
          filter={filter}
          categories={CATALOG}
          onClearQuery={onClearQuery}
          onClearCategory={onClearCategory}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const status = () => screen.getByTestId('vitrine-status');

beforeEach(() => {
  api.listServices.mockReset();
  onClearQuery.mockReset();
  onClearCategory.mockReset();
});
afterEach(() => {
  if (realGeo) Object.defineProperty(navigator, 'geolocation', realGeo);
});

describe('searchPath', () => {
  it('leva a busca do topo para a busca do app (q e categoria)', () => {
    expect(searchPath({ q: '', categoryId: null })).toBe('/servicos');
    expect(searchPath({ q: 'logo e site', categoryId: 13 })).toBe(
      '/servicos?q=logo+e+site&categoria=13',
    );
  });
});

describe('Showcase', () => {
  it('sem filtro: os mais recentes, com o status e o cartão do app', async () => {
    api.listServices.mockResolvedValue(
      pageOf(Array.from({ length: SHOWCASE_LIMIT }, (_, i) => service(i + 1))),
    );
    renderShowcase();
    expect(status()).toHaveTextContent('Carregando serviços…');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Descubra serviços');
    await waitFor(() => expect(status()).toHaveTextContent('Os 8 serviços mais recentes.'));
    expect(screen.getAllByRole('article')).toHaveLength(8);
    expect(screen.getByRole('link', { name: 'Serviço 1' })).toHaveAttribute('href', '/servicos/1');
    expect(screen.queryByRole('list', { name: 'Filtros da vitrine' })).not.toBeInTheDocument();
  });

  it('com busca e categoria: os dois filtros aparecem e saem pelo "x"', async () => {
    const user = userEvent.setup();
    api.listServices.mockResolvedValue(pageOf([service(1)]));
    renderShowcase({ q: 'logo', categoryId: 13 });
    expect(api.listServices).toHaveBeenCalledWith({ q: 'logo', categoryId: 13, limit: 8 });
    await waitFor(() => expect(status()).toHaveTextContent('1 serviço encontrado.'));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Resultados da busca');
    const filters = screen.getByRole('list', { name: 'Filtros da vitrine' });
    expect(
      within(filters)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['“logo”', 'Identidade Visual']);
    await user.click(screen.getByRole('button', { name: 'Tirar a busca “logo”' }));
    expect(onClearQuery).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Tirar a categoria Identidade Visual' }));
    expect(onClearCategory).toHaveBeenCalledTimes(1);
  });

  it('localização no clique: ordena por distância num raio fixo e pode ser tirada', async () => {
    const user = userEvent.setup();
    stubGeolocation((ok) => ok({ coords: { latitude: -26.3, longitude: -48.85 } }));
    api.listServices.mockResolvedValue(pageOf([service(1), service(2)]));
    renderShowcase();
    await waitFor(() => expect(status()).toHaveTextContent('2 serviços encontrados.'));
    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    await waitFor(() =>
      expect(api.listServices).toHaveBeenLastCalledWith({
        lat: -26.3,
        lng: -48.85,
        radiusKm: NEARBY_KM,
        sort: 'distance',
        limit: 8,
      }),
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Perto de você');
    expect(
      screen.queryByRole('button', { name: 'Usar minha localização' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tirar a localização' }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Descubra serviços');
    await waitFor(() => expect(api.listServices).toHaveBeenLastCalledWith({ limit: 8 }));
  });

  it('com a localização e a vitrine cheia, o status fala dos mais próximos', async () => {
    const user = userEvent.setup();
    stubGeolocation((ok) => ok({ coords: { latitude: 1, longitude: 2 } }));
    api.listServices.mockResolvedValue(
      pageOf(Array.from({ length: SHOWCASE_LIMIT }, (_, i) => service(i + 1))),
    );
    renderShowcase();
    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    await waitFor(() => expect(status()).toHaveTextContent('Os 8 serviços mais próximos.'));
  });

  it('localização negada: avisa e segue pelos mais recentes', async () => {
    const user = userEvent.setup();
    stubGeolocation((_ok, fail) => fail());
    api.listServices.mockResolvedValue(pageOf([service(1)]));
    renderShowcase();
    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Não deu para usar a sua localização.');
    expect(screen.getByRole('button', { name: 'Usar minha localização' })).toBeEnabled();
    expect(api.listServices).toHaveBeenCalledTimes(1);
  });

  it('navegador sem localização: avisa sem pedir nada', async () => {
    const user = userEvent.setup();
    stubGeolocation(null);
    api.listServices.mockResolvedValue(pageOf([service(1)]));
    renderShowcase();
    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Este navegador não oferece localização.');
  });

  it('enquanto localiza, o botão espera', async () => {
    const user = userEvent.setup();
    stubGeolocation(() => undefined);
    api.listServices.mockResolvedValue(pageOf([service(1)]));
    renderShowcase();
    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    expect(screen.getByRole('button', { name: 'Localizando…' })).toBeDisabled();
  });

  it.each([
    [{ q: 'logo', categoryId: 13 }, 'Nada encontrado para “logo” em Identidade Visual'],
    [{ q: 'logo', categoryId: null }, 'Nada encontrado para “logo”'],
    [{ q: '', categoryId: 13 }, 'Nenhum serviço em Identidade Visual ainda'],
    [{ q: '', categoryId: null }, 'Nenhum serviço publicado ainda'],
  ] as const)('sem resultado (%j): "%s", com saída e sem número', async (filter, title) => {
    const user = userEvent.setup();
    api.listServices.mockResolvedValue(pageOf([]));
    renderShowcase(filter);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(status()).toHaveTextContent('Nenhum serviço encontrado.');
    expect(screen.getByRole('link', { name: 'Publicar o primeiro serviço' })).toHaveAttribute(
      'href',
      '/cadastro?perfil=freelancer',
    );
    const clear = screen.queryByRole('button', { name: 'Limpar os filtros' });
    if (filter.q || filter.categoryId !== null) {
      await user.click(clear!);
      expect(onClearQuery).toHaveBeenCalled();
      expect(onClearCategory).toHaveBeenCalled();
    } else expect(clear).not.toBeInTheDocument();
  });

  it('ninguém por perto: o vazio fala do raio', async () => {
    const user = userEvent.setup();
    stubGeolocation((ok) => ok({ coords: { latitude: 1, longitude: 2 } }));
    api.listServices.mockResolvedValueOnce(pageOf([service(1)])).mockResolvedValue(pageOf([]));
    renderShowcase();
    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    expect(await screen.findByText('Ninguém por perto ainda')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`num raio de ${NEARBY_KM} km`))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpar os filtros' }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Descubra serviços');
  });

  it('erro da API: o aviso e o "tentar de novo", sem status de contagem', async () => {
    const user = userEvent.setup();
    api.listServices.mockRejectedValueOnce(new Error('Fora do ar'));
    renderShowcase();
    expect(await screen.findByRole('alert')).toHaveTextContent('Fora do ar');
    expect(status()).toHaveTextContent('');
    api.listServices.mockResolvedValue(pageOf([service(1)]));
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('link', { name: 'Serviço 1' })).toBeInTheDocument();
  });
});
