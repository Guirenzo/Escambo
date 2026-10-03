import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Notification, NotificationList } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { NotificacoesView } from './NotificacoesView';

/**
 * Central de notificações: o que conta como não lida (subtítulo, título da aba e o botão de marcar
 * todas), para onde cada aviso leva e quando a tela avisa a API de que um aviso foi lido.
 */

const notifications = vi.fn();
const markNotificationRead = vi.fn();
const markAllNotificationsRead = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    notifications: () => notifications(),
    markNotificationRead: (id: number) => markNotificationRead(id),
    markAllNotificationsRead: (...args: unknown[]) => markAllNotificationsRead(...args),
  },
}));

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificacoesView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const note = (o: Partial<Notification> & { id: number }): Notification => ({
  type: 'contract_update',
  title: `Aviso ${o.id}`,
  body: null,
  data: null,
  isRead: false,
  createdAt: '2026-09-20T15:30:00.000Z',
  ...o,
});

const list = (items: Notification[]): NotificationList => ({
  items,
  unreadCount: items.filter((n) => !n.isRead).length,
  page: 1,
  limit: 20,
});

beforeEach(() => {
  notifications.mockReset();
  markNotificationRead.mockReset();
  markNotificationRead.mockResolvedValue(undefined);
  markAllNotificationsRead.mockReset();
  markAllNotificationsRead.mockResolvedValue({ read: 2 });
});

describe('NotificacoesView', () => {
  it('enquanto a lista não chega, mostra o esqueleto e não oferece "marcar todas"', () => {
    notifications.mockReturnValue(new Promise(() => undefined));
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: 'Notificações' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByText('Sem notificações.')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Marcar todas como lidas' }),
    ).not.toBeInTheDocument();
  });

  it('sem avisos: diz que está tudo em dia, sem botão e sem contador na aba', async () => {
    notifications.mockResolvedValue(list([]));
    renderView();

    expect(await screen.findByText('Sem notificações.')).toBeInTheDocument();
    expect(screen.getByText('Tudo em dia.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Marcar todas como lidas' }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe('Notificações · Escambo');
  });

  it('lista título, texto e data de cada aviso, e conta as não lidas no subtítulo e na aba', async () => {
    notifications.mockResolvedValue(
      list([
        note({ id: 1, title: 'Proposta aceita', body: 'A Marina aceitou sua proposta.' }),
        note({ id: 2, title: 'Saque pago', createdAt: '2026-09-21T09:05:00.000Z' }),
        note({ id: 3, title: 'Bem-vindo', isRead: true, createdAt: '2026-09-01T12:00:00.000Z' }),
      ]),
    );
    renderView();

    expect(await screen.findByText('Proposta aceita')).toBeInTheDocument();
    expect(screen.getByText('A Marina aceitou sua proposta.')).toBeInTheDocument();
    expect(screen.getByText('Saque pago')).toBeInTheDocument();
    expect(screen.getByText('Bem-vindo')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText(dtm('2026-09-21T09:05:00.000Z'))).toBeInTheDocument();
    expect(screen.getByText(dtm('2026-09-01T12:00:00.000Z'))).toBeInTheDocument();
    expect(screen.getByText('2 não lidas')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('(2) Notificações · Escambo'));
    expect(screen.getByRole('button', { name: 'Marcar todas como lidas' })).toBeEnabled();
  });

  it('uma só não lida fica no singular', async () => {
    notifications.mockResolvedValue(list([note({ id: 1 }), note({ id: 2, isRead: true })]));
    renderView();

    expect(await screen.findByText('1 não lida')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('(1) Notificações · Escambo'));
  });

  it('o link leva à tela do assunto, com o rótulo do tipo; aviso sem destino não tem link', async () => {
    notifications.mockResolvedValue(
      list([
        note({ id: 1, title: 'Entrega registrada', data: { contractId: 7 } }),
        note({
          id: 2,
          title: 'Novo serviço na sua busca',
          type: 'saved_search_match',
          data: { savedSearchId: 3 },
        }),
        note({
          id: 3,
          title: 'Imagem removida',
          type: 'content_removed',
          data: { removalId: 9 },
        }),
        note({
          id: 4,
          title: 'Contestação decidida',
          type: 'appeal_decided',
          data: { removalId: 9 },
        }),
        note({ id: 5, title: 'Aviso geral' }),
      ]),
    );
    renderView();

    expect(await screen.findByRole('link', { name: 'Abrir' })).toHaveAttribute(
      'href',
      '/contratos/7',
    );
    expect(screen.getByRole('link', { name: 'Ver serviços' })).toHaveAttribute(
      'href',
      '/servicos?busca=3',
    );
    const profileLinks = screen.getAllByRole('link', { name: 'Ver perfil' });
    expect(profileLinks.map((a) => a.getAttribute('href'))).toEqual(['/perfil', '/perfil']);
    // Cinco avisos, quatro links: o aviso sem dados não leva a lugar nenhum.
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('clicar num aviso não lido marca só ele como lido; num já lido, nada é enviado', async () => {
    const user = userEvent.setup();
    notifications.mockResolvedValue(
      list([note({ id: 11, title: 'Novo' }), note({ id: 12, title: 'Antigo', isRead: true })]),
    );
    renderView();

    await user.click(await screen.findByText('Antigo'));
    expect(markNotificationRead).not.toHaveBeenCalled();

    await user.click(screen.getByText('Novo'));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledTimes(1));
    expect(markNotificationRead).toHaveBeenCalledWith(11);
    // A lista é recarregada depois de marcar (o contador vem do servidor).
    await waitFor(() => expect(notifications).toHaveBeenCalledTimes(2));
  });

  it('abrir pelo link de um aviso não lido marca como lido uma vez só', async () => {
    const user = userEvent.setup();
    notifications.mockResolvedValue(
      list([note({ id: 21, title: 'Marco aprovado', data: { contractId: 4 } })]),
    );
    renderView();

    await user.click(await screen.findByRole('link', { name: 'Abrir' }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith(21));
    expect(markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it('abrir pelo link de um aviso já lido não envia nada', async () => {
    const user = userEvent.setup();
    notifications.mockResolvedValue(
      list([note({ id: 22, title: 'Troca aceita', isRead: true, data: { barterId: 5 } })]),
    );
    renderView();

    const link = await screen.findByRole('link', { name: 'Abrir' });
    expect(link).toHaveAttribute('href', '/trocas');
    await user.click(link);
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it('"Marcar todas como lidas" chama a API uma vez, recarrega e some quando não sobra nenhuma', async () => {
    const user = userEvent.setup();
    const unread = [note({ id: 1, title: 'Primeiro' }), note({ id: 2, title: 'Segundo' })];
    notifications.mockResolvedValueOnce(list(unread));
    notifications.mockResolvedValue(list(unread.map((n) => ({ ...n, isRead: true }))));
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Marcar todas como lidas' }));

    await waitFor(() => expect(markAllNotificationsRead).toHaveBeenCalledTimes(1));
    expect(markAllNotificationsRead).toHaveBeenCalledWith();
    expect(await screen.findByText('Tudo em dia.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Marcar todas como lidas' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Primeiro')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Notificações · Escambo'));
  });

  it('enquanto "marcar todas" está indo, o botão fica desabilitado', async () => {
    const user = userEvent.setup();
    notifications.mockResolvedValue(list([note({ id: 1 })]));
    let release!: (v: { read: number }) => void;
    markAllNotificationsRead.mockReturnValue(
      new Promise<{ read: number }>((resolve) => (release = resolve)),
    );
    renderView();

    const button = await screen.findByRole('button', { name: 'Marcar todas como lidas' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    release({ read: 1 });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('se a API falha, mostra a mensagem e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    notifications.mockRejectedValueOnce(new Error('Sem conexão com o servidor.'));
    notifications.mockResolvedValue(list([note({ id: 1, title: 'Voltou' })]));
    renderView();

    expect(await screen.findByRole('alert')).toHaveTextContent('Sem conexão com o servidor.');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText('Voltou')).toBeInTheDocument();
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
