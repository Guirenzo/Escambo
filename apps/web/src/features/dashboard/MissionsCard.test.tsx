import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mission } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionsCard, missionDeadline } from './MissionsCard';

/**
 * Cartão de missões do Início (RF-066, RN-054): o progresso de cada uma, quanto falta para o
 * período virar, as cumpridas, e a busca de novo quando o dia ou a semana vira.
 */

const missions = vi.fn();
vi.mock('../../lib/api', () => ({ api: { missions: () => missions() } }));

// Quarta, 21/10/2026, 12:00 em Brasília.
const NOW = new Date('2026-10-21T15:00:00Z');

const mission = (o: Partial<Mission>): Mission => ({
  id: 1,
  title: 'Maratona da semana',
  description: 'Conclua 3 serviços nesta semana',
  type: 'weekly',
  action: 'complete_contracts',
  xpReward: 200,
  progress: 2,
  target: 3,
  completed: false,
  completedAt: null,
  expiresAt: '2026-10-26T02:59:59.000Z',
  ...o,
});

const SEED: Mission[] = [
  mission({
    id: 3,
    title: 'Presença diária',
    description: 'Acesse a plataforma hoje',
    type: 'daily',
    action: 'daily_login',
    xpReward: 10,
    progress: 1,
    target: 1,
    completed: true,
    completedAt: NOW.toISOString(),
    expiresAt: '2026-10-22T02:59:59.000Z',
  }),
  mission({}),
  mission({
    id: 4,
    title: 'Primeira troca',
    description: null,
    type: 'achievement',
    action: 'complete_barter',
    xpReward: 150,
    progress: 0,
    target: 1,
    expiresAt: null,
  }),
];

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MissionsCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  missions.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('missionDeadline', () => {
  const now = NOW.getTime();
  it('quanto falta até o segundo seguinte ao 23:59:59', () => {
    expect(missionDeadline(mission({}), now)).toBe('Expira em 4 dias e 12 h');
    expect(missionDeadline(mission({ expiresAt: '2026-10-21T15:40:59.000Z' }), now)).toBe(
      'Expira em 41 min',
    );
  });
  it('cumprida e sem prazo', () => {
    expect(missionDeadline(mission({ completed: true }), now)).toBe('Cumprida');
    expect(missionDeadline(mission({ expiresAt: null }), now)).toBe('Sem prazo');
  });
});

describe('MissionsCard', () => {
  it('mostra cada missão com o tipo, o progresso, o prazo e o XP', async () => {
    missions.mockResolvedValue(SEED);
    renderCard();

    const card = (await screen.findByRole('heading', { name: 'Missões' })).closest('section')!;
    expect(within(card).getByText('1 de 3 cumpridas')).toBeInTheDocument();

    const daily = within(card).getByText('Presença diária').closest('li')!;
    expect(within(daily).getByText('Diária')).toBeInTheDocument();
    expect(within(daily).getByText('1/1 · Cumprida')).toBeInTheDocument();
    expect(within(daily).getByText(/\+10 XP/)).toBeInTheDocument();

    const weekly = within(card).getByText('Maratona da semana').closest('li')!;
    expect(within(weekly).getByText('Semanal')).toBeInTheDocument();
    expect(within(weekly).getByText('2/3 · Expira em 4 dias e 12 h')).toBeInTheDocument();
    const bar = within(weekly).getByRole('progressbar', {
      name: 'Progresso de Maratona da semana',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(bar).toHaveAttribute('aria-valuetext', '2 de 3');

    const achievement = within(card).getByText('Primeira troca').closest('li')!;
    expect(within(achievement).getByText('Conquista')).toBeInTheDocument();
    expect(within(achievement).getByText('0/1 · Sem prazo')).toBeInTheDocument();
  });

  it('sem missões (cliente, conta sem perfil de freelancer) não mostra o cartão', async () => {
    missions.mockResolvedValue([]);
    const { container } = renderCard();
    await waitFor(() => expect(missions).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('erro ao carregar mostra o aviso com "Tentar de novo"', async () => {
    missions.mockRejectedValueOnce(new Error('Falhou')).mockResolvedValue(SEED);
    renderCard();

    expect(await screen.findByRole('alert')).toHaveTextContent('Falhou');
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Maratona da semana')).toBeInTheDocument();
  });

  it('o "expira em" anda com o relógio e, quando o dia vira, as missões são buscadas de novo', async () => {
    const today = mission({
      id: 5,
      title: 'Diária aberta',
      type: 'daily',
      progress: 0,
      target: 1,
      expiresAt: '2026-10-21T15:01:59.000Z',
    });
    missions
      .mockResolvedValueOnce([today])
      .mockResolvedValue([{ ...today, expiresAt: '2026-10-22T15:01:59.000Z' }]);
    renderCard();

    expect(await screen.findByText('0/1 · Expira em 2 min')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText('0/1 · Expira em 1 min')).toBeInTheDocument();

    // O período acaba às 15:02:00: o cartão busca de novo e mostra o período novo.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(missions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('0/1 · Expira em 1 dia')).toBeInTheDocument();
  });
});
