import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { qk, useSupportActions, useSupportTicket, useSupportTickets } from './hooks';
import { supportTicket } from '../test/support-fixtures';

vi.mock('./api');
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('cache do suporte', () => {
  it.each([false, true])(
    'consultas de escopo admin=%s separam fila/detalhe e só carregam anteriores a pedido',
    async (admin) => {
      const list = vi
        .mocked(admin ? api.adminSupportTickets : api.supportTickets)
        .mockResolvedValue({ items: [], page: 2, limit: 20 });
      const detail = vi
        .mocked(admin ? api.adminSupportTicket : api.supportTicket)
        .mockImplementation(async (_id, before) =>
          supportTicket({ nextBeforeId: before ? null : 51 }),
        );
      const { client, wrapper } = setup();
      const query = { page: 2, limit: 20, status: 'open' as const };
      const hook = renderHook(
        () => ({ list: useSupportTickets(query, admin), ticket: useSupportTicket(7, admin) }),
        { wrapper },
      );
      await waitFor(() => expect(hook.result.current.ticket.isSuccess).toBe(true));
      expect(list).toHaveBeenCalledWith(query);
      expect(detail).toHaveBeenCalledExactlyOnceWith(7, undefined);
      expect(client.getQueryData(qk.supportTickets(admin, query))).toEqual({
        items: [],
        page: 2,
        limit: 20,
      });
      expect(hook.result.current.ticket.hasNextPage).toBe(true);
      await act(async () => {
        await hook.result.current.ticket.fetchNextPage();
      });
      expect(detail).toHaveBeenCalledWith(7, 51);
      await waitFor(() => expect(hook.result.current.ticket.hasNextPage).toBe(false));
      expect(client.getQueryData(qk.supportTicket(!admin, 7))).toBeUndefined();
    },
  );
  it('sem seleção não consulta detalhe', async () => {
    const { wrapper } = setup();
    const hook = renderHook(() => useSupportTicket(null), { wrapper });
    expect(hook.result.current.fetchStatus).toBe('idle');
    expect(api.supportTicket).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'poll de fila e detalhe admin=%s só acontece com a aba visível',
    async (admin) => {
      vi.useFakeTimers();
      focusManager.setFocused(true);
      const list = vi
        .mocked(admin ? api.adminSupportTickets : api.supportTickets)
        .mockResolvedValue({ items: [], page: 1, limit: 20 });
      const detail = vi
        .mocked(admin ? api.adminSupportTicket : api.supportTicket)
        .mockResolvedValue(supportTicket());
      const { wrapper } = setup();
      renderHook(
        () => ({ list: useSupportTickets({ page: 1 }, admin), detail: useSupportTicket(7, admin) }),
        { wrapper },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(list).toHaveBeenCalledTimes(1);
      expect(detail).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(list).toHaveBeenCalledTimes(2);
      expect(detail).toHaveBeenCalledTimes(2);
      act(() => focusManager.setFocused(false));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(list).toHaveBeenCalledTimes(2);
      expect(detail).toHaveBeenCalledTimes(2);
      await act(async () => {
        focusManager.setFocused(true);
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(list).toHaveBeenCalledTimes(3);
      expect(detail).toHaveBeenCalledTimes(3);
    },
  );
  it.each([false, true])(
    'ações admin=%s invalidam fila/detalhe e notificações no escopo correto',
    async (admin) => {
      vi.mocked(api.createSupportTicket).mockResolvedValue(supportTicket());
      vi.mocked(api.replySupportTicket).mockResolvedValue(supportTicket());
      vi.mocked(api.adminReplySupportTicket).mockResolvedValue(supportTicket());
      vi.mocked(api.closeSupportTicket).mockResolvedValue(supportTicket());
      vi.mocked(api.adminUpdateSupportTicket).mockResolvedValue(supportTicket());
      const { wrapper, invalidate } = setup();
      const hook = renderHook(() => useSupportActions(admin), { wrapper });
      await act(async () => {
        await hook.result.current.create.mutateAsync({
          category: 'other',
          subject: 'Ajuda',
          description: 'Descrição suficiente',
        });
      });
      await act(async () => {
        await hook.result.current.reply.mutateAsync({
          id: 7,
          body: { message: 'Resposta', internal: true, resolve: false },
        });
      });
      expect(admin ? api.adminReplySupportTicket : api.replySupportTicket).toHaveBeenCalledWith(
        7,
        admin ? { message: 'Resposta', internal: true, resolve: false } : { message: 'Resposta' },
      );
      await act(async () => {
        await hook.result.current.close.mutateAsync(7);
      });
      await act(async () => {
        await hook.result.current.update.mutateAsync({ id: 7, body: { priority: 'low' } });
      });
      expect(invalidate.mock.calls.map(([filter]) => filter?.queryKey)).toEqual(
        Array.from({ length: 4 }, () => [qk.support(admin), qk.notifications]).flat(),
      );
    },
  );
  it('erro da ação não invalida dados como se tivesse sido concluída', async () => {
    vi.mocked(api.replySupportTicket).mockRejectedValue(new Error('Negado'));
    const { wrapper, invalidate } = setup();
    const hook = renderHook(() => useSupportActions(), { wrapper });
    await act(async () => {
      await expect(
        hook.result.current.reply.mutateAsync({ id: 7, body: { message: 'Olá' } }),
      ).rejects.toThrow('Negado');
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
