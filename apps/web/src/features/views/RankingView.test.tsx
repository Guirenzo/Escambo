import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RankingView } from './RankingView';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 2, ulid: 'u-rafael', email: 'r@e.com', role: 'freelancer' } }),
}));

vi.mock('../../lib/api', () => ({
  api: {
    leaderboard: vi.fn().mockResolvedValue([
      { rank: 1, userUlid: 'u-marina', name: 'Marina Alves', totalXp: 2600, level: 4, levelName: 'Especialista' },
      { rank: 2, userUlid: 'u-bruno', name: 'Bruno Costa', totalXp: 1400, level: 3, levelName: 'Profissional' },
      { rank: 3, userUlid: 'u-rafael', name: 'Rafael Souza', totalXp: 950, level: 3, levelName: 'Profissional' },
      { rank: 4, userUlid: 'u-carla', name: 'Carla Dias', totalXp: 520, level: 2, levelName: 'Aprendiz' },
    ]),
    gamification: vi.fn().mockResolvedValue({ rank: 3, totalXp: 950, level: 3, levelName: 'Profissional' }),
  },
}));

/** Providers mínimos da fundação (camada de dados) para renderizar telas em teste. */
function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe('RankingView', () => {
  it('renderiza o pódio, a lista e o destaque do usuário logado', async () => {
    render(wrap(<RankingView />));

    expect(await screen.findByText('Marina Alves')).toBeInTheDocument();
    expect(screen.getByText('Bruno Costa')).toBeInTheDocument();
    expect(screen.getByText('Rafael Souza')).toBeInTheDocument();
    expect(screen.getByText('Carla Dias')).toBeInTheDocument();
    expect(await screen.findByText('Você é #3')).toBeInTheDocument();
  });
});
