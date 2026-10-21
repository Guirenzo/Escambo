import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { avatarTone, RankingView } from './RankingView';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 2, ulid: 'u-rafael', email: 'r@e.com', role: 'freelancer' } }),
}));

const entry = (o: Record<string, unknown>) => ({
  level: 3,
  levelName: 'Profissional',
  avgRating: 0,
  completedContracts: 0,
  ...o,
});

const GLOBAL = [
  entry({ rank: 1, userUlid: 'u-marina', name: 'Marina Alves', totalXp: 2600, level: 4 }),
  entry({ rank: 2, userUlid: 'u-bruno', name: 'Bruno Costa', totalXp: 1400 }),
  entry({ rank: 3, userUlid: 'u-rafael', name: 'Rafael Souza', totalXp: 950 }),
  entry({ rank: 4, userUlid: 'u-carla', name: 'Carla Dias', totalXp: 520, level: 2 }),
];

const LOCAL = [
  entry({
    rank: 1,
    userUlid: 'u-ana',
    name: 'Ana Lima',
    totalXp: 40,
    avgRating: 5,
    completedContracts: 1,
    distanceKm: 0.6,
  }),
  entry({
    rank: 2,
    userUlid: 'u-rafael',
    name: 'Rafael Souza',
    totalXp: 950,
    avgRating: 4.8,
    completedContracts: 12,
    distanceKm: 3.2,
  }),
  entry({ rank: 3, userUlid: 'u-bia', name: 'Bia', avgRating: 4.8, completedContracts: 9 }),
  entry({
    rank: 4,
    userUlid: 'u-caio',
    name: 'Caio',
    totalXp: 10,
    avgRating: 4.5,
    completedContracts: 1,
    distanceKm: 12,
  }),
];

const leaderboard = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    leaderboard: (...args: unknown[]) => leaderboard(...args),
    gamification: () =>
      Promise.resolve({ rank: 3, totalXp: 950, level: 3, levelName: 'Profissional' }),
    categories: () =>
      Promise.resolve([
        {
          id: 1,
          name: 'Tecnologia',
          children: [{ id: 10, name: 'Desenvolvimento Web', children: [] }],
        },
      ]),
  },
}));

/** Providers mínimos da fundação (camada de dados e avisos) para renderizar telas em teste. */
function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
function setGeolocation(value: unknown): void {
  Object.defineProperty(navigator, 'geolocation', { value, configurable: true });
}

beforeEach(() => {
  leaderboard.mockReset();
  leaderboard.mockImplementation((filter?: unknown) =>
    Promise.resolve(filter === undefined ? GLOBAL : LOCAL),
  );
});
afterEach(() => {
  if (original) Object.defineProperty(navigator, 'geolocation', original);
  else delete (navigator as unknown as Record<string, unknown>).geolocation;
});

describe('RankingView', () => {
  it('renderiza o pódio, a lista e o destaque do usuário logado', async () => {
    render(wrap(<RankingView />));

    expect(await screen.findByText('Marina Alves')).toBeInTheDocument();
    expect(screen.getByText('Bruno Costa')).toBeInTheDocument();
    expect(screen.getByText('Rafael Souza')).toBeInTheDocument();
    expect(screen.getByText('Carla Dias')).toBeInTheDocument();
    expect(await screen.findByText('Você é #3')).toBeInTheDocument();
    expect(leaderboard).toHaveBeenCalledWith();
  });

  it('por categoria: pede a categoria e mostra a nota e as concluídas (RN-056)', async () => {
    const user = userEvent.setup();
    render(wrap(<RankingView />));
    await screen.findByText('Marina Alves');
    await screen.findByRole('option', { name: '— Desenvolvimento Web' });

    await user.selectOptions(screen.getByLabelText('Categoria do ranking'), '10');

    expect(await screen.findByText('Ana Lima')).toBeInTheDocument();
    expect(leaderboard).toHaveBeenLastCalledWith({ categoryId: 10 });
    expect(screen.getByText(/pela nota média, depois pelas contratações concluídas/)).toBeVisible();
    // A posição geral por XP não vale no ranking filtrado.
    expect(screen.queryByText('Você é #3')).not.toBeInTheDocument();
    const caio = screen.getByText('Caio').closest('li')!;
    expect(within(caio).getByText('★ 4,5 · 1 concluída · a 12 km')).toBeInTheDocument();
    // No pódio, os critérios no lugar do XP; sem distância, só a nota e as concluídas.
    expect(screen.getByText(/★ 5,0 · 1 concluída · a 0,6 km/)).toBeInTheDocument();
    expect(screen.getByText(/★ 4,8 · 9 concluídas$/)).toBeInTheDocument();
    expect(screen.queryByText('2600 XP')).not.toBeInTheDocument();
  });

  it('perto de mim: manda a localização do navegador; desligar volta ao geral', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: -26.3, longitude: -48.8 } } as GeolocationPosition),
    );
    setGeolocation({ getCurrentPosition });
    const user = userEvent.setup();
    render(wrap(<RankingView />));
    await screen.findByText('Marina Alves');

    await user.click(screen.getByRole('button', { name: /Perto de mim/ }));
    expect(await screen.findByText('Ana Lima')).toBeInTheDocument();
    expect(leaderboard).toHaveBeenLastCalledWith({ lat: -26.3, lng: -48.8 });
    expect(screen.getByRole('button', { name: /Perto de mim: ativo/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /Perto de mim: ativo/ }));
    expect(await screen.findByText('Marina Alves')).toBeInTheDocument();
    expect(await screen.findByText('Você é #3')).toBeInTheDocument();
  });

  it('sem localização, avisa e continua no geral', async () => {
    setGeolocation({
      getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
        fail({ code: 1 } as GeolocationPositionError),
    });
    const user = userEvent.setup();
    render(wrap(<RankingView />));
    await screen.findByText('Marina Alves');

    await user.click(screen.getByRole('button', { name: /Perto de mim/ }));
    expect(await screen.findByText('Não consegui obter sua localização')).toBeInTheDocument();
    expect(leaderboard).toHaveBeenCalledTimes(1);
  });

  it('navegador sem geolocalização (o jsdom não tem): avisa', async () => {
    expect('geolocation' in navigator).toBe(false);
    const user = userEvent.setup();
    render(wrap(<RankingView />));
    await screen.findByText('Marina Alves');

    await user.click(screen.getByRole('button', { name: /Perto de mim/ }));
    expect(await screen.findByText('Seu navegador não oferece geolocalização')).toBeInTheDocument();
    expect(leaderboard).toHaveBeenCalledTimes(1);
  });

  it('erro ao carregar o ranking oferece tentar de novo', async () => {
    leaderboard.mockRejectedValueOnce(new Error('Ranking fora do ar'));
    const user = userEvent.setup();
    render(wrap(<RankingView />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ranking fora do ar');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Marina Alves')).toBeInTheDocument();
  });

  it('filtro sem ninguém mostra o vazio próprio', async () => {
    leaderboard.mockImplementation((filter?: unknown) =>
      Promise.resolve(filter === undefined ? GLOBAL : []),
    );
    const user = userEvent.setup();
    render(wrap(<RankingView />));
    await screen.findByRole('option', { name: 'Tecnologia' });

    await user.selectOptions(screen.getByLabelText('Categoria do ranking'), '1');
    expect(await screen.findByText('Ninguém nesse filtro ainda.')).toBeInTheDocument();
  });
});

describe('RankingView: pódio', () => {
  it('o pódio fica num palco com nome, na ordem 2º, 1º e 3º, com a posição escrita em cada um', async () => {
    render(wrap(<RankingView />));
    const stage = await screen.findByRole('region', { name: 'Pódio' });
    const cols = Array.from(stage.querySelectorAll('.podium-col'));
    expect(cols.map((c) => c.querySelector('.medal')?.textContent)).toEqual(['2º', '1º', '3º']);
    expect(cols[1]!.querySelector('.podium-crown')).not.toBeNull();
    expect(cols[0]!.querySelector('.podium-crown')).toBeNull();
    // O degrau repete a posição só para os olhos.
    expect(cols[1]!.querySelector('.stand')).toHaveAttribute('aria-hidden', 'true');
  });

  it('a cor do avatar de iniciais é a mesma para a mesma pessoa, e uma das seis do sistema', () => {
    const tones = ['a-green', 'a-blue', 'a-violet', 'a-amber', 'a-red', 'a-teal'];
    expect(avatarTone('01MARINA')).toBe(avatarTone('01MARINA'));
    expect(tones).toContain(avatarTone('01MARINA'));
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarTone)).size).toBeGreaterThan(
      1,
    );
  });
});
