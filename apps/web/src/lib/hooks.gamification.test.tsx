import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api } from './api';
import { useLeaderboard, useMissions } from './hooks';

/** Missões e ranking filtrado: a chave do cache e o método da API de cada consulta. */

vi.mock('./api');

const mocked = (method: keyof typeof api): Mock =>
  (api as unknown as Record<string, Mock>)[method]!;

const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe('consultas da gamificação', () => {
  it('useMissions guarda em ["missions"] o que api.missions devolve', async () => {
    mocked('missions').mockResolvedValue([{ id: 3, completedAt: null }]);
    const { client, Wrapper } = wrapper();
    const { result } = renderHook(() => useMissions(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 3, completedAt: null }]));
    expect(mocked('missions')).toHaveBeenCalledWith();
    expect(client.getQueryData(['missions'])).toEqual([{ id: 3, completedAt: null }]);
  });

  it('missão cumprida pela própria leitura (a presença do dia) relê o XP e o ranking', async () => {
    mocked('missions').mockResolvedValue([
      { id: 3, completedAt: new Date(Date.now() - 2_000).toISOString() },
    ]);
    const { client, Wrapper } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMissions(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['gamification'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['leaderboard'] });
  });

  it('missão cumprida antes, ou não cumprida, não relê nada', async () => {
    mocked('missions').mockResolvedValue([
      { id: 3, completedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
      { id: 4, completedAt: null },
    ]);
    const { client, Wrapper } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMissions(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('useLeaderboard sem filtro: a chave de sempre e a chamada sem argumento', async () => {
    mocked('leaderboard').mockResolvedValue([]);
    const { client, Wrapper } = wrapper();
    const { result } = renderHook(() => useLeaderboard(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocked('leaderboard')).toHaveBeenCalledWith();
    expect(client.getQueryData(['leaderboard'])).toEqual([]);
  });

  it('useLeaderboard com filtro: cada filtro na sua chave, debaixo de ["leaderboard"]', async () => {
    mocked('leaderboard').mockResolvedValue([{ rank: 1 }]);
    const filter = { categoryId: 10, lat: 1, lng: 2 };
    const { client, Wrapper } = wrapper();
    const { result } = renderHook(() => useLeaderboard(filter), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocked('leaderboard')).toHaveBeenCalledWith(filter);
    expect(client.getQueryData(['leaderboard', filter])).toEqual([{ rank: 1 }]);
  });
});
