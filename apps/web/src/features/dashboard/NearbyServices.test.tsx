import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Category, Service } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { NearbyServices } from './NearbyServices';

/**
 * "Perto de você" no Início: com a localização do perfil, os serviços mais perto (raio de 50 km);
 * sem ela, os mais recentes e o botão que pede a localização do navegador, só no clique. Os
 * próprios serviços não aparecem, e o carrossel anda com anterior/próximo.
 */

const api = vi.hoisted(() => ({
  profilesMe: vi.fn(),
  listServices: vi.fn(),
  categories: vi.fn(),
  publicSettings: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

const ME = 7;
const auth = vi.hoisted(() => ({
  user: { id: 7, role: 'freelancer', timezone: 'America/Sao_Paulo' },
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const categories: Category[] = [
  {
    id: 1,
    parentId: null,
    name: 'Design',
    slug: 'design',
    iconUrl: null,
    children: [
      {
        id: 13,
        parentId: 1,
        name: 'Identidade Visual',
        slug: 'identidade-visual',
        iconUrl: null,
        children: [],
      },
    ],
  },
];

const service = (o: Partial<Service> = {}): Service => ({
  id: 1,
  categoryId: 13,
  ownerId: 9,
  title: 'Identidade visual (logo + guia)',
  description: 'Logo, paleta e guia.',
  priceType: 'fixed',
  price: 800,
  deliveryDays: 10,
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

const pageOf = (items: Service[]) => ({ items, page: 1, limit: 12 });

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

function renderNearby() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <NearbyServices />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  auth.user = { id: ME, role: 'freelancer', timezone: 'America/Sao_Paulo' };
  api.profilesMe.mockResolvedValue({
    freelancer: { fullName: 'Bruno Costa', city: 'Joinville', latitude: -26.3, longitude: -48.8 },
    client: null,
  });
  api.listServices.mockResolvedValue(
    pageOf([service(), service({ id: 2, ownerId: ME, title: 'Meu próprio serviço' })]),
  );
  api.categories.mockResolvedValue(categories);
  api.publicSettings.mockResolvedValue({ barterEnabled: true });
});

afterEach(() => {
  delete (navigator as { geolocation?: unknown }).geolocation;
});

describe('NearbyServices', () => {
  it('com a localização do perfil, busca do mais perto ao mais longe num raio de 50 km, sem os próprios', async () => {
    renderNearby();
    const section = await screen.findByRole('region', { name: 'Perto de você' });
    expect(
      within(section).getByText('Até 50 km de Joinville, pela localização do seu perfil.'),
    ).toBeInTheDocument();
    expect(
      await within(section).findByRole('link', { name: 'Identidade visual (logo + guia)' }),
    ).toHaveAttribute('href', '/servicos/1');
    expect(screen.queryByText('Meu próprio serviço')).not.toBeInTheDocument();
    expect(api.listServices).toHaveBeenCalledTimes(1);
    expect(api.listServices).toHaveBeenCalledWith({
      lat: -26.3,
      lng: -48.8,
      radiusKm: 50,
      sort: 'distance',
      limit: 12,
    });
    // Sem pedir nada ao navegador e sem o convite para usar a localização.
    expect(
      screen.queryByRole('button', { name: 'Usar minha localização' }),
    ).not.toBeInTheDocument();
    // Cartão compacto: sem descrição nem botões; a capa sem imagem leva o tom da categoria raiz.
    expect(screen.queryByText('Logo, paleta e guia.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contratar' })).not.toBeInTheDocument();
    await waitFor(() => expect(section.querySelector('.svc-cover')).toHaveClass('cover-violet'));
    expect(within(section).getByRole('link', { name: 'Ver todos' })).toHaveAttribute(
      'href',
      '/servicos',
    );
  });

  it('perfil sem cidade fala só em "você"', async () => {
    api.profilesMe.mockResolvedValue({
      freelancer: { fullName: 'Bruno Costa', city: null, latitude: -26.3, longitude: -48.8 },
      client: null,
    });
    renderNearby();
    expect(
      await screen.findByText('Até 50 km de você, pela localização do seu perfil.'),
    ).toBeInTheDocument();
  });

  it('sem localização: mostra os recentes e pede a do navegador só no clique', async () => {
    const user = userEvent.setup();
    auth.user = { id: ME, role: 'client', timezone: 'America/Sao_Paulo' };
    api.profilesMe.mockResolvedValue({ freelancer: null, client: { fullName: 'Ana' } });
    const locate = vi.fn<Locate>((ok) => ok({ coords: { latitude: -26.31, longitude: -48.85 } }));
    stubGeolocation(locate);
    renderNearby();

    expect(await screen.findByRole('region', { name: 'Descubra serviços' })).toBeInTheDocument();
    expect(screen.getByText('Os serviços mais recentes do Escambo.')).toBeInTheDocument();
    await screen.findByRole('link', { name: 'Identidade visual (logo + guia)' });
    expect(api.listServices).toHaveBeenCalledWith({ limit: 12 });
    expect(locate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Usar minha localização' }));
    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate.mock.calls[0]![2]).toEqual({ timeout: 8000 });
    expect(await screen.findByRole('region', { name: 'Perto de você' })).toBeInTheDocument();
    expect(screen.getByText('Pela sua localização de agora, até 50 km.')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.listServices).toHaveBeenLastCalledWith({
        lat: -26.31,
        lng: -48.85,
        radiusKm: 50,
        sort: 'distance',
        limit: 12,
      }),
    );
  });

  it('localização negada ou navegador sem geolocalização: avisa e continua na lista recente', async () => {
    const user = userEvent.setup();
    api.profilesMe.mockResolvedValue({ freelancer: null, client: null });
    stubGeolocation((_ok, fail) => fail());
    const first = renderNearby();
    await user.click(await screen.findByRole('button', { name: 'Usar minha localização' }));
    expect(await screen.findByText('Não consegui obter sua localização')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Descubra serviços' })).toBeInTheDocument();
    first.unmount();

    delete (navigator as { geolocation?: unknown }).geolocation;
    renderNearby();
    await user.click(await screen.findByRole('button', { name: 'Usar minha localização' }));
    expect(await screen.findByText('Seu navegador não oferece geolocalização')).toBeInTheDocument();
  });

  it('enquanto localiza, o botão diz e fica travado', async () => {
    const user = userEvent.setup();
    api.profilesMe.mockResolvedValue({ freelancer: null, client: null });
    stubGeolocation(() => undefined);
    renderNearby();
    await user.click(await screen.findByRole('button', { name: 'Usar minha localização' }));
    const busy = screen.getByRole('button', { name: 'Localizando…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });

  it('ninguém por perto: diz isso e leva a todos os serviços; sem localização, outro texto', async () => {
    api.listServices.mockResolvedValue(pageOf([]));
    const first = renderNearby();
    expect(await screen.findByText('Ninguém por perto ainda')).toBeInTheDocument();
    expect(
      screen.getByText('Nenhum serviço num raio de 50 km. Os remotos atendem de qualquer lugar.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver todos' })).toHaveAttribute('href', '/servicos');
    // Sem cartões, sem anterior/próximo.
    expect(screen.queryByRole('button', { name: 'Ver os próximos' })).not.toBeInTheDocument();
    first.unmount();

    api.profilesMe.mockResolvedValue({ freelancer: null, client: null });
    renderNearby();
    expect(await screen.findByText('Nenhum serviço publicado ainda')).toBeInTheDocument();
  });

  it('falha ao buscar: mostra o erro e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    api.listServices.mockRejectedValueOnce(new Error('Erro ao listar serviços.'));
    renderNearby();
    expect(await screen.findByRole('alert')).toHaveTextContent('Erro ao listar serviços.');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(
      await screen.findByRole('link', { name: 'Identidade visual (logo + guia)' }),
    ).toBeInTheDocument();
  });

  it('anterior/próximo rolam o carrossel e travam nas pontas', async () => {
    const user = userEvent.setup();
    renderNearby();
    const link = await screen.findByRole('link', { name: 'Identidade visual (logo + guia)' });
    const track = link.closest<HTMLElement>('.carousel')!;
    const prev = screen.getByRole('button', { name: 'Ver os anteriores' });
    const next = screen.getByRole('button', { name: 'Ver os próximos' });
    // No jsdom nada tem tamanho: tudo cabe, os dois ficam travados.
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled();

    const scrollBy = vi.fn();
    Object.assign(track, { scrollBy });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 1200 });
    track.scrollLeft = 0;
    fireEvent.scroll(track);
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
    await user.click(next);
    expect(scrollBy).toHaveBeenCalledWith({ left: 340, behavior: 'smooth' });

    track.scrollLeft = 800;
    fireEvent.scroll(track);
    expect(prev).toBeEnabled();
    expect(next).toBeDisabled();
    await user.click(prev);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -340, behavior: 'smooth' });

    // Mudar o tamanho da janela mede de novo.
    track.scrollLeft = 0;
    fireEvent(window, new Event('resize'));
    expect(prev).toBeDisabled();
  });
});
