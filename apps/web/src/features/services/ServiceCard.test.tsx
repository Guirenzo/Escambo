import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Service } from '@escambo/types';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceCard } from './ServiceCard';

const publicSettings = vi.fn();
vi.mock('../../lib/api', () => ({ api: { publicSettings: () => publicSettings() } }));

/** Quem está vendo o card: o fuso dele decide se a agenda do prestador ganha "(horário de …)". */
const viewer: { user: { id: number; timezone: string } | null } = {
  user: { id: 1, timezone: 'America/Sao_Paulo' },
};
vi.mock('../../lib/auth', () => ({ useAuth: () => viewer }));

const service = (o: Partial<Service> = {}): Service => ({
  id: 5,
  categoryId: 2,
  ownerId: 9,
  title: 'Logo profissional',
  description: 'Crio a identidade visual da sua marca.',
  priceType: 'fixed',
  price: 150,
  deliveryDays: 5,
  isRemote: false,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  ownerUlid: '01HZXULIDBRUNA',
  ownerName: 'Bruna Lima',
  ownerAvatarUrl: null,
  ownerRating: 4.5,
  ownerReviews: 12,
  ...o,
});

type Props = ComponentProps<typeof ServiceCard>;

function renderCard(props: Partial<Props> = {}) {
  const handlers = { onContratar: vi.fn(), onBoost: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ServiceCard service={service()} mine={false} {...handlers} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return handlers;
}

beforeEach(() => {
  publicSettings.mockReset();
  publicSettings.mockResolvedValue({ barterEnabled: true });
  viewer.user = { id: 1, timezone: 'America/Sao_Paulo' };
});

/** Card de serviço da busca e do perfil público. */
describe('ServiceCard', () => {
  it('mostra título, descrição, preço, prazo e quem presta, com link para o perfil', () => {
    renderCard();

    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
    expect(screen.getByText('Crio a identidade visual da sua marca.')).toBeInTheDocument();
    expect(screen.getByText('R$ 150,00')).toBeInTheDocument();
    expect(screen.getByText('5 dias')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bruna Lima' })).toHaveAttribute(
      'href',
      '/freelancers/01HZXULIDBRUNA',
    );
    expect(screen.getByRole('img', { name: '4.5 de 5, 12 avaliações' })).toBeInTheDocument();
    expect(screen.queryByText('remoto')).not.toBeInTheDocument();
    expect(screen.queryByText('Destaque')).not.toBeInTheDocument();
  });

  it('sem preço diz "a combinar"; na busca por proximidade a distância toma o lugar do prazo', () => {
    renderCard({ service: service({ price: null, distanceKm: 3.2, isRemote: true }) });

    expect(screen.getByText('a combinar')).toBeInTheDocument();
    expect(screen.getByText('3.2 km de você')).toBeInTheDocument();
    expect(screen.queryByText('5 dias')).not.toBeInTheDocument();
    expect(screen.getByText('remoto')).toBeInTheDocument();
  });

  it('sem distância nem prazo o rodapé fica só com o preço', () => {
    renderCard({ service: service({ deliveryDays: null }) });

    expect(screen.getByText('R$ 150,00')).toBeInTheDocument();
    expect(screen.queryByText(/dias$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/km de você/)).not.toBeInTheDocument();
  });

  it('prestador sem avaliações aparece com a nota zerada, e sem ulid o nome não vira link', () => {
    renderCard({
      service: service({ ownerUlid: undefined, ownerRating: undefined, ownerReviews: undefined }),
    });

    expect(screen.getByText('Bruna Lima')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '0.0 de 5, 0 avaliações' })).toBeInTheDocument();
  });

  it('serviço sem o nome de quem presta não mostra a linha do prestador', () => {
    renderCard({ service: service({ ownerName: undefined, ownerAvailableNow: true }) });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /de 5/ })).not.toBeInTheDocument();
    expect(screen.queryByText('atende agora')).not.toBeInTheDocument();
    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
  });

  it('showOwner desligado (perfil público) esconde quem presta', () => {
    renderCard({ showOwner: false, service: service({ ownerAvailableNow: true }) });

    expect(screen.queryByText('Bruna Lima')).not.toBeInTheDocument();
    expect(screen.queryByText('atende agora')).not.toBeInTheDocument();
    expect(screen.getByText('Logo profissional')).toBeInTheDocument();
  });

  it('agenda do prestador: "atende agora" e os dias com períodos, sem nota de fuso quando é o mesmo', () => {
    renderCard({
      service: service({
        ownerAvailableNow: true,
        ownerAvailableDays: [1, 2, 3, 4, 5],
        ownerAvailablePeriods: {
          '1': ['morning', 'afternoon'],
          '2': ['morning', 'afternoon'],
          '3': ['morning', 'afternoon'],
          '4': ['morning', 'afternoon'],
          '5': ['morning', 'afternoon'],
        },
        ownerTimezone: 'America/Sao_Paulo',
      }),
    });

    expect(screen.getByText('atende agora')).toBeInTheDocument();
    expect(screen.getByText('atende seg a sex · manhã e tarde')).toBeInTheDocument();
  });

  it('prestador em outro fuso: a agenda diz de onde é o horário', () => {
    renderCard({
      service: service({ ownerAvailableDays: [1, 3], ownerTimezone: 'America/Manaus' }),
    });

    expect(screen.getByText('atende seg, qua (horário de Manaus)')).toBeInTheDocument();
    expect(screen.queryByText('atende agora')).not.toBeInTheDocument();
  });

  it('visitante sem sessão é tratado como horário de Brasília', () => {
    viewer.user = null;
    renderCard({
      service: service({ ownerAvailableDays: [6], ownerTimezone: 'America/Sao_Paulo' }),
    });

    expect(screen.getByText('atende sáb')).toBeInTheDocument();
  });

  it('prestador sem dias informados não ganha o selo de agenda', () => {
    renderCard({ service: service({ ownerAvailableDays: [] }) });

    expect(screen.queryByText(/^atende/)).not.toBeInTheDocument();
  });

  it('serviço dos outros: "Contratar" devolve o serviço clicado', async () => {
    const user = userEvent.setup();
    const s = service();
    const { onContratar, onBoost } = renderCard({ service: s });

    await user.click(screen.getByRole('button', { name: 'Contratar' }));

    expect(onContratar).toHaveBeenCalledTimes(1);
    expect(onContratar).toHaveBeenCalledWith(s);
    expect(onBoost).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Impulsionar/ })).not.toBeInTheDocument();
  });

  it('meu serviço: só "Impulsionar", que devolve o serviço; nada de contratar, favoritar ou trocar', async () => {
    const user = userEvent.setup();
    const s = service();
    const onToggleFavorite = vi.fn();
    const onProposeBarter = vi.fn();
    const { onBoost } = renderCard({ service: s, mine: true, onToggleFavorite, onProposeBarter });

    expect(screen.queryByRole('button', { name: 'Contratar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Favoritar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Impulsionar' }));
    expect(onBoost).toHaveBeenCalledTimes(1);
    expect(onBoost).toHaveBeenCalledWith(s);
  });

  it('meu serviço já impulsionado: selo "Destaque" e o botão travado em "Impulsionado"', async () => {
    const user = userEvent.setup();
    const { onBoost } = renderCard({ service: service({ boosted: true }), mine: true });

    expect(screen.getByText('Destaque')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Impulsionado' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onBoost).not.toHaveBeenCalled();
  });

  it('favorito: o coração diz o que vai fazer, mostra o estado e devolve o serviço', async () => {
    const user = userEvent.setup();
    const s = service();
    const onToggleFavorite = vi.fn();
    renderCard({ service: s, onToggleFavorite, favorited: false });

    const heart = screen.getByRole('button', { name: 'Favoritar' });
    expect(heart).toHaveAttribute('aria-pressed', 'false');
    await user.click(heart);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledWith(s);
  });

  it('já favoritado: o coração fica marcado e oferece remover', () => {
    renderCard({ onToggleFavorite: vi.fn(), favorited: true });

    expect(screen.getByRole('button', { name: 'Remover dos favoritos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Favoritar' })).not.toBeInTheDocument();
  });

  it('sem quem trate o favorito (visitante) o coração não aparece', () => {
    renderCard();

    expect(screen.queryByRole('button', { name: 'Favoritar' })).not.toBeInTheDocument();
  });

  it('"Propor troca" só existe para quem pode propor, e devolve o serviço', async () => {
    const user = userEvent.setup();
    const s = service();
    const onProposeBarter = vi.fn();
    const { onContratar } = renderCard({ service: s, onProposeBarter });

    await user.click(screen.getByRole('button', { name: 'Propor troca' }));
    expect(onProposeBarter).toHaveBeenCalledTimes(1);
    expect(onProposeBarter).toHaveBeenCalledWith(s);
    expect(onContratar).not.toHaveBeenCalled();
  });

  it('cliente (sem onProposeBarter) não vê "Propor troca"', async () => {
    renderCard();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeInTheDocument();
  });

  it('com a troca desligada pela plataforma, "Propor troca" some e "Contratar" fica', async () => {
    publicSettings.mockResolvedValue({ barterEnabled: false });
    renderCard({ onProposeBarter: vi.fn() });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeInTheDocument();
  });
});
