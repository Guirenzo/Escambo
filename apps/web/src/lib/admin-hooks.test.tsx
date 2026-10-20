import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ADMIN_METRICS_REFRESH_MS, qk, useAdminMetrics, useAdminUsage } from './hooks';

vi.mock('./api');
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

/** Painel do admin (RF-076, RF-081): indicadores que se renovam sozinhos e o uso por período. */
describe('hooks do painel do admin', () => {
  it('os indicadores consultam de novo a cada 30 s, só com a aba visível', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const metrics = vi.mocked(api.adminMetrics).mockResolvedValue({} as never);
    const { wrapper } = setup();
    renderHook(() => useAdminMetrics(), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(metrics).toHaveBeenCalledTimes(1);
    expect(ADMIN_METRICS_REFRESH_MS).toBe(30_000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(metrics).toHaveBeenCalledTimes(2);

    // Aba em segundo plano: nada de consulta, por mais tempo que passe.
    act(() => focusManager.setFocused(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(metrics).toHaveBeenCalledTimes(2);

    // De volta à aba: atualiza na hora e retoma o intervalo.
    await act(async () => {
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(metrics).toHaveBeenCalledTimes(3);
  });

  it('o uso por período fica na chave do recorte e pede à API o mesmo recorte', async () => {
    const report = { series: [] };
    const usage = vi.mocked(api.adminUsage).mockResolvedValue(report as never);
    const { client, wrapper } = setup();
    const q = { from: '2026-09-01', to: '2026-09-30', granularity: 'week' as const };

    const { result } = renderHook(() => useAdminUsage(q), { wrapper });

    await waitFor(() => expect(result.current.data).toBe(report));
    expect(usage).toHaveBeenCalledWith(q);
    expect(client.getQueryData(['adminUsage', q])).toBe(report);
    expect(qk.adminMetrics).toEqual(['adminMetrics']);
  });
});
