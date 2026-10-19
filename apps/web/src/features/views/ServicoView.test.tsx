import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Favorite, Service } from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { ServicoView } from './ServicoView';

/**
 * Detalhe do serviço (/servicos/:id): o que quem abre vê (descrição inteira, quem presta, preço,
 * prazo, modalidade e tags que levam à busca) e o que pode fazer dali. Abrir pede o serviço à API,
 * que conta a visualização (RF-029); o número nunca aparece aqui.
 */

vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  service: vi.fn(),
  favorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  publicSettings: vi.fn(),
  publicFreelancer: vi.fn(),
  wallet: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

interface Viewer {
  id: number;
  role: 'client' | 'freelancer';
  timezone: string;
}
const auth = vi.hoisted(() => ({ user: null as Viewer | null }));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const OWNER = 7;
const VISITOR = 3;

const service = (o: Partial<Service> = {}): Service => ({
  id: 41,
  categoryId: 2,
  ownerId: OWNER,
  title: 'Fotografia de eventos',
  description: 'Cobertura completa.\nEntrega em galeria online.',
  priceType: 'fixed',
  price: 900,
  deliveryDays: 1,
  isRemote: true,
  modality: 'both',
  tags: ['casamento', 'fotografia'],
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  boosted: true,
  ownerUlid: 'u-marina',
  ownerName: 'Marina Alves',
  ownerAvatarUrl: null,
  ownerRating: 4.8,
  ownerReviews: 12,
  ...o,
});

const fav = (targetId: number): Favorite => ({
  id: 1,
  targetType: 'service',
  targetId,
  createdAt: '2026-10-01T12:00:00.000Z',
});

function Where() {
  const l = useLocation();
  return <p data-testid="rota">{l.pathname + l.search}</p>;
}

function renderAt(id = 41) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/inicio', `/servicos/${id}`]} initialIndex={1}>
          <Routes>
            <Route path="/servicos/:id" element={<ServicoView serviceId={id} />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const expectRoute = (path: string) =>
  waitFor(() => expect(screen.getByTestId('rota').textContent).toBe(path));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  auth.user = { id: VISITOR, role: 'client', timezone: 'America/Sao_Paulo' };
  api.service.mockResolvedValue(service());
  api.favorites.mockResolvedValue([]);
  api.addFavorite.mockResolvedValue(undefined);
  api.removeFavorite.mockResolvedValue(undefined);
  api.publicSettings.mockResolvedValue({
    minServicePrice: 10,
    barterEnabled: true,
    platformFeePercentage: 15,
  });
  api.publicFreelancer.mockResolvedValue(null);
  api.wallet.mockResolvedValue({ balance: 0, pending: 0, credits: 0 });
});

describe('ServicoView', () => {
  it('pede o serviço pelo id e mostra título, quem presta, preço, prazo, modalidade e a descrição inteira', async () => {
    renderAt();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fotografia de eventos' }),
    ).toBeVisible();
    expect(api.service).toHaveBeenCalledWith(41);
    expect(screen.getByRole('link', { name: 'Marina Alves' })).toHaveAttribute(
      'href',
      '/freelancers/u-marina',
    );
    expect(screen.getByText('R$ 900,00')).toBeVisible();
    expect(screen.getByText('entrega em 1 dia')).toBeVisible();
    expect(screen.getByText('remoto e presencial')).toBeVisible();
    expect(screen.getByText('Destaque')).toBeVisible();
    expect(screen.getByText(/Cobertura completa\.\s+Entrega em galeria online\./)).toBeVisible();
    // O número de visualizações é do dono, em "Meus serviços": nunca no detalhe.
    expect(screen.queryByText(/visualiza/)).toBeNull();
  });

  it('as tags levam à busca por elas', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    const tags = await screen.findByRole('list', { name: 'Tags' });
    expect(
      within(tags)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['casamento', 'fotografia']);
    await user.click(screen.getByRole('link', { name: 'Buscar pela tag fotografia' }));
    await expectRoute('/servicos?q=fotografia');
  });

  it('"Contratar" abre o modal de contratação deste serviço', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Contratar' }));
    const dialog = screen.getByRole('dialog', { name: 'Contratar: Fotografia de eventos' });
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('o coração favorita e desfaz; o estado vem dos favoritos de quem vê', async () => {
    const user = userEvent.setup({ delay: null });
    // Primeiro sem favoritos; depois de favoritar, a lista recarregada já traz este serviço.
    api.favorites.mockResolvedValueOnce([]).mockResolvedValue([fav(41)]);
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Favoritar' }));
    expect(api.addFavorite).toHaveBeenCalledWith({ targetType: 'service', targetId: 41 });

    const unfav = await screen.findByRole('button', { name: 'Remover dos favoritos' });
    expect(unfav).toHaveAttribute('aria-pressed', 'true');
    await user.click(unfav);
    expect(api.removeFavorite).toHaveBeenCalledWith('service', 41);
  });

  it('cliente não propõe troca; freelancer vai às trocas com este serviço; troca desligada some', async () => {
    const user = userEvent.setup({ delay: null });
    const first = renderAt();
    await screen.findByRole('button', { name: 'Contratar' });
    expect(screen.queryByRole('button', { name: 'Propor troca' })).toBeNull();
    first.unmount();

    auth.user = { id: VISITOR, role: 'freelancer', timezone: 'America/Sao_Paulo' };
    api.publicSettings.mockResolvedValue({ minServicePrice: 10, barterEnabled: false });
    const second = renderAt();
    await screen.findByRole('button', { name: 'Contratar' });
    await waitFor(() => expect(api.publicSettings).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Propor troca' })).toBeNull();
    second.unmount();

    api.publicSettings.mockResolvedValue({ minServicePrice: 10, barterEnabled: true });
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Propor troca' }));
    await expectRoute('/trocas?propor=41');
  });

  it('o dono vê que o serviço é dele, sem contratar nem favoritar', async () => {
    auth.user = { id: OWNER, role: 'freelancer', timezone: 'America/Sao_Paulo' };
    renderAt();
    expect(await screen.findByTestId('own-service')).toHaveTextContent('Este serviço é seu.');
    expect(screen.queryByRole('button', { name: 'Contratar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Favoritar' })).toBeNull();
  });

  it('pausado: aparece marcado e sem "Contratar"; sem prazo e sem tags, nada disso aparece', async () => {
    api.service.mockResolvedValue(
      service({
        isActive: false,
        boosted: false,
        deliveryDays: null,
        tags: [],
        modality: undefined,
        isRemote: false,
      }),
    );
    renderAt();
    expect(await screen.findByTestId('paused-note')).toBeVisible();
    expect(screen.getByText('Pausado')).toBeVisible();
    expect(screen.getByText('presencial')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Contratar' })).toBeNull();
    expect(screen.queryByText(/entrega em/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Tags' })).toBeNull();
    expect(screen.queryByText('Destaque')).toBeNull();
  });

  it('sem o nome de quem presta, a linha do prestador some; sem ulid, o nome não vira link', async () => {
    api.service.mockResolvedValueOnce(service({ ownerName: undefined }));
    const first = renderAt();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Marina Alves')).toBeNull();
    first.unmount();

    api.service.mockResolvedValueOnce(service({ ownerUlid: undefined }));
    renderAt();
    expect(await screen.findByText('Marina Alves')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Marina Alves' })).toBeNull();
  });

  it('erro ao carregar: mostra o motivo e "Tentar de novo" pede de novo; "Voltar" volta', async () => {
    const user = userEvent.setup({ delay: null });
    api.service.mockRejectedValueOnce(new Error('Serviço não encontrado'));
    renderAt();
    expect(await screen.findByText('Serviço não encontrado')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fotografia de eventos' }),
    ).toBeVisible();
    expect(api.service).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    await expectRoute('/inicio');
  });
});
