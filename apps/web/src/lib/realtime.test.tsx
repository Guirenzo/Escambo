import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen } from '@testing-library/react';
import type { Notification } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeNotifications } from './realtime';
import { ToastProvider } from './toast';

/**
 * Tempo real (socket `notification:new`): cada tipo de aviso marca como velhas as consultas que
 * ele muda, e a pessoa vê um toast com o título — menos a mensagem de chat com a Sala aberta, que
 * já aparece no próprio chat.
 */

type Handler = (n: Notification) => void;
const socket = {
  on: vi.fn<(event: string, handler: Handler) => void>(),
  off: vi.fn<(event: string, handler: Handler) => void>(),
};
vi.mock('./socket', () => ({ getSocket: () => socket }));

const notification = (type: string, title = 'Aviso novo'): Notification => ({
  id: 1,
  type,
  title,
  body: null,
  data: null,
  isRead: false,
  createdAt: '2026-10-02T12:00:00.000Z',
});

function mount() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  const view = renderHook(() => useRealtimeNotifications(), { wrapper });
  const [event, handler] = socket.on.mock.calls[0]!;
  return {
    view,
    event,
    handler,
    /** Entrega um aviso como o servidor faria. */
    receive: (n: Notification) => act(() => handler(n)),
    invalidated: (): string[] =>
      invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey)).sort(),
  };
}

const keys = (...list: unknown[][]): string[] => list.map((k) => JSON.stringify(k)).sort();

beforeEach(() => {
  // O toast some sozinho depois de alguns segundos: relógio de mentira para o timer não sobrar.
  vi.useFakeTimers();
  socket.on.mockClear();
  socket.off.mockClear();
  window.history.pushState({}, '', '/painel');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  window.history.pushState({}, '', '/');
});

describe('avisos em tempo real', () => {
  const CONTRACT = [['notifications'], ['contracts'], ['contract'], ['wallet'], ['gamification']];
  const MONEY = [
    ['notifications'],
    ['wallet'],
    ['walletTransactions'],
    ['deposits'],
    ['withdrawals'],
    ['deposit'],
  ];
  const LGPD = [['notifications'], ['exportRequests'], ['deletionRequests']];
  const MODERATION = [
    ['notifications'],
    ['profiles'],
    ['portfolio'],
    ['publicFreelancer'],
    ['myModeration'],
    ['contract'],
    ['reviews'],
    ['chat'],
  ];

  const cases: Array<[type: string, invalidates: unknown[][]]> = [
    ['contract_accepted', CONTRACT],
    ['milestone_delivered', CONTRACT],
    // ADR 57: extensão de prazo e disputa também mudam a Sala.
    ['deadline_extension_requested', CONTRACT],
    ['dispute_opened', CONTRACT],
    ['barter_proposed', [['notifications'], ['barters'], ['contracts']]],
    ['deposit_confirmed', MONEY],
    ['withdrawal_completed', MONEY],
    ['export_ready', LGPD],
    ['deletion_completed', LGPD],
    ['saved_search_match', [['notifications'], ['savedSearches'], ['services']]],
    ['review_received', [['notifications'], ['profiles'], ['reviews']]],
    ['content_removed', MODERATION],
    ['appeal_decided', MODERATION],
    // Aviso que não muda dado de tela nenhuma: só o sino atualiza.
    ['level_up', [['notifications']]],
    ['chat_message', [['notifications']]],
  ];

  it.each(cases)('%s recarrega só o que esse aviso muda', (type, invalidates) => {
    const { receive, invalidated } = mount();
    receive(notification(type));
    expect(invalidated()).toEqual(keys(...invalidates));
  });

  it('escuta "notification:new" ao entrar e para de escutar ao sair, com o mesmo ouvinte', () => {
    const { view, event, handler } = mount();
    expect(event).toBe('notification:new');
    expect(socket.on).toHaveBeenCalledTimes(1);
    expect(socket.off).not.toHaveBeenCalled();

    view.unmount();

    expect(socket.off).toHaveBeenCalledTimes(1);
    expect(socket.off).toHaveBeenCalledWith('notification:new', handler);
  });

  it('o aviso aparece para a pessoa como um toast com o título', () => {
    const { receive } = mount();
    receive(notification('contract_accepted', 'Sua proposta foi aceita'));
    expect(screen.getByRole('status')).toHaveTextContent('Sua proposta foi aceita');
  });

  // Na lista de contratações (/contratos) nenhum chat está aberto: só a Sala (/contratos/7) cala.
  it.each(['/painel', '/contratos'])(
    'mensagem de chat fora da Sala (%s) avisa com toast',
    (path) => {
      window.history.pushState({}, '', path);
      const { receive } = mount();
      receive(notification('chat_message', 'Nova mensagem de Ana'));
      expect(screen.getByRole('status')).toHaveTextContent('Nova mensagem de Ana');
    },
  );

  it('mensagem de chat com a Sala aberta não repete o aviso em toast', () => {
    window.history.pushState({}, '', '/contratos/7');
    const { receive, invalidated } = mount();

    receive(notification('chat_message', 'Nova mensagem de Ana'));

    expect(screen.queryByText('Nova mensagem de Ana')).not.toBeInTheDocument();
    // O sino continua atualizando.
    expect(invalidated()).toEqual(keys(['notifications']));
  });

  it('na Sala, aviso que não é de chat continua aparecendo', () => {
    window.history.pushState({}, '', '/contratos/7');
    const { receive } = mount();
    receive(notification('milestone_delivered', 'Marco entregue'));
    expect(screen.getByText('Marco entregue')).toBeInTheDocument();
  });

  it('um novo render da tela não registra o ouvinte de novo', () => {
    const { view } = mount();
    view.rerender();
    view.rerender();
    expect(socket.on).toHaveBeenCalledTimes(1);
    expect(socket.off).not.toHaveBeenCalled();
  });
});
