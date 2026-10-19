import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupportTicketDetail } from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessProvider } from '../../lib/account-access';
import { ToastProvider } from '../../lib/toast';
import { supportMessage, supportTicket } from '../../test/support-fixtures';
import { SupportSection } from '../admin/SupportSection';
import { SuporteView } from '../views/SuporteView';

const api = vi.hoisted(() => ({
  supportTickets: vi.fn(),
  supportTicket: vi.fn(),
  createSupportTicket: vi.fn(),
  replySupportTicket: vi.fn(),
  closeSupportTicket: vi.fn(),
  adminSupportTickets: vi.fn(),
  adminSupportTicket: vi.fn(),
  adminReplySupportTicket: vi.fn(),
  adminUpdateSupportTicket: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

let ticket: SupportTicketDetail;
const clients: QueryClient[] = [];
function Location() {
  const loc = useLocation();
  return (
    <output aria-label="Endereço">
      {loc.pathname}
      {loc.search}
      {loc.hash}
    </output>
  );
}
function mount({
  admin = false,
  selected = true,
  suspended = false,
  url,
}: { admin?: boolean; selected?: boolean; suspended?: boolean; url?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <AccountAccessProvider status={suspended ? 'suspended' : 'active'}>
        <ToastProvider>
          <MemoryRouter
            initialEntries={[
              url ??
                `${admin ? '/admin' : '/suporte'}${selected ? '?ticket=7' : ''}${admin ? '#suporte' : ''}`,
            ]}
          >
            <Routes>
              <Route
                path="*"
                element={
                  <>
                    {admin ? <SupportSection /> : <SuporteView />}
                    <Location />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </AccountAccessProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const conversation = () => within(screen.getByRole('region', { name: 'Detalhes do chamado' }));
async function ready() {
  await screen.findByText(/01SUPORTEPROTOCOLO/);
}
async function fillOpen(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Abrir chamado' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Abrir chamado' }));
  await user.type(dialog.getByLabelText('Assunto'), '  Preciso de ajuda  ');
  await user.type(dialog.getByLabelText('Descrição'), '  Minha conta precisa de atendimento.  ');
  return dialog;
}

beforeEach(() => {
  vi.resetAllMocks();
  ticket = supportTicket();
  api.supportTickets.mockImplementation(async () => ({ items: [ticket], page: 1, limit: 20 }));
  api.adminSupportTickets.mockImplementation(async () => ({ items: [ticket], page: 1, limit: 20 }));
  api.supportTicket.mockImplementation(async () => ticket);
  api.adminSupportTicket.mockImplementation(async () => ticket);
  api.createSupportTicket.mockImplementation(async () => ticket);
  api.replySupportTicket.mockImplementation(async () => ticket);
  api.adminReplySupportTicket.mockImplementation(async () => ticket);
  api.closeSupportTicket.mockImplementation(async () => {
    ticket = { ...ticket, status: 'closed', closedAt: '2026-10-15T13:00:00.000Z' };
    return ticket;
  });
  api.adminUpdateSupportTicket.mockImplementation(async (_id, body) => {
    ticket = { ...ticket, ...body };
    return ticket;
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
});

describe('suporte do titular', () => {
  it('abre durante suspensão, normaliza texto e seleciona o protocolo criado', async () => {
    const user = mount({ selected: false, suspended: true });
    expect(screen.getByRole('heading', { name: 'Suporte', level: 1 })).toBeInTheDocument();
    const dialog = await fillOpen(user);
    expect(dialog.getByText(/Até 3 chamados/)).toBeInTheDocument();
    expect(dialog.getByText(/não abre disputa financeira/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Enviar chamado' }));
    await waitFor(() =>
      expect(api.createSupportTicket).toHaveBeenCalledWith({
        category: 'account',
        subject: 'Preciso de ajuda',
        description: 'Minha conta precisa de atendimento.',
        contractId: null,
      }),
    );
    await ready();
    expect(screen.getByLabelText('Endereço')).toHaveTextContent('/suporte?ticket=7');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('exige contratação na categoria relacionada e envia somente o vínculo informado', async () => {
    const user = mount({ selected: false });
    const dialog = await fillOpen(user);
    await user.selectOptions(dialog.getByLabelText('Categoria'), 'dispute');
    const contract = dialog.getByLabelText('Número da contratação (obrigatório)');
    expect(contract).toBeRequired();
    await user.type(contract, '19');
    await user.click(dialog.getByRole('button', { name: 'Enviar chamado' }));
    expect(api.createSupportTicket).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'dispute', contractId: 19 }),
    );
  });
  it('não envia assunto/descrição formados só por espaços e respeita limites dos campos', async () => {
    const user = mount({ selected: false });
    await user.click(screen.getByRole('button', { name: 'Abrir chamado' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Assunto'), { target: { value: '   ' } });
    fireEvent.change(dialog.getByLabelText('Descrição'), { target: { value: '          ' } });
    fireEvent.submit(dialog.getByRole('button', { name: 'Enviar chamado' }).closest('form')!);
    expect(await dialog.findByRole('alert')).toHaveTextContent('pelo menos 3 caracteres');
    expect(api.createSupportTicket).not.toHaveBeenCalled();
    expect(dialog.getByLabelText('Assunto')).toHaveAttribute('maxlength', '150');
    expect(dialog.getByLabelText('Descrição')).toHaveAttribute('maxlength', '5000');
    await user.click(dialog.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it.each([
    ['ticket_duplicate', 'Já existe um chamado não encerrado'],
    ['ticket_limit', 'Você já tem 3 chamados'],
    ['Falha de conexão', 'Falha de conexão'],
  ])('mantém texto após erro %s na abertura', async (code, copy) => {
    api.createSupportTicket.mockRejectedValue(new Error(code));
    const user = mount({ selected: false });
    const dialog = await fillOpen(user);
    await user.click(dialog.getByRole('button', { name: 'Enviar chamado' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(copy);
    expect(dialog.getByLabelText('Assunto')).toHaveValue('  Preciso de ajuda  ');
    expect(dialog.getByRole('button', { name: 'Enviar chamado' })).toBeEnabled();
  });
  it('evita envios repetidos enquanto a abertura está pendente', async () => {
    api.createSupportTicket.mockImplementation(() => new Promise(() => undefined));
    const user = mount({ selected: false });
    const dialog = await fillOpen(user);
    const form = dialog.getByRole('button', { name: 'Enviar chamado' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(api.createSupportTicket).toHaveBeenCalledTimes(1));
    expect(dialog.getByRole('button', { name: 'Abrindo…' })).toBeDisabled();
  });
  it('consulta a conversa com protocolo e nunca mostra notas internas, mesmo se o payload estiver errado', async () => {
    ticket = supportTicket({
      contractId: 19,
      messages: [
        supportMessage(1),
        supportMessage(2, { from: 'support', message: 'Resposta pública' }),
        supportMessage(3, { internal: true, message: 'Segredo da equipe' }),
      ],
    });
    mount();
    await ready();
    expect(conversation().getByText('Resposta pública')).toBeInTheDocument();
    expect(screen.queryByText('Segredo da equipe')).not.toBeInTheDocument();
    expect(conversation().getByRole('link', { name: 'Contratação #19' })).toHaveAttribute(
      'href',
      '/contratos/19',
    );
    expect(screen.queryByLabelText('Prioridade')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nota interna/)).not.toBeInTheDocument();
  });
  it('envia mensagem durante suspensão sem comandos administrativos nem bloquear o formulário', async () => {
    const user = mount({ suspended: true });
    await ready();
    await user.type(
      conversation().getByLabelText('Sua mensagem'),
      '  Continuo precisando de ajuda  ',
    );
    await user.click(conversation().getByRole('button', { name: 'Enviar mensagem' }));
    await waitFor(() =>
      expect(api.replySupportTicket).toHaveBeenCalledWith(7, {
        message: 'Continuo precisando de ajuda',
      }),
    );
    await waitFor(() => expect(conversation().getByLabelText('Sua mensagem')).toHaveValue(''));
    expect(api.adminReplySupportTicket).not.toHaveBeenCalled();
  });
  it('resolved permite responder para retomar; encerrado não permite novas mensagens', async () => {
    ticket = supportTicket({ status: 'resolved', resolvedAt: '2026-10-15T12:00:00.000Z' });
    const user = mount();
    await ready();
    expect(conversation().getByText(/em até 5 dias/)).toBeInTheDocument();
    await user.type(conversation().getByLabelText('Sua mensagem'), 'Ainda não foi resolvido');
    await user.click(conversation().getByRole('button', { name: 'Enviar mensagem' }));
    expect(api.replySupportTicket).toHaveBeenCalledWith(7, { message: 'Ainda não foi resolvido' });
    await user.click(conversation().getByRole('button', { name: 'Encerrar chamado' }));
    await waitFor(() =>
      expect(conversation().queryByLabelText('Sua mensagem')).not.toBeInTheDocument(),
    );
    expect(conversation().getByText(/Para outro atendimento/)).toBeInTheDocument();
  });
  it('encerra durante suspensão e libera a interface para outro atendimento', async () => {
    const user = mount({ suspended: true });
    await ready();
    await user.click(conversation().getByRole('button', { name: 'Encerrar chamado' }));
    expect(api.closeSupportTicket).toHaveBeenCalledWith(7);
    await waitFor(() =>
      expect(
        conversation().queryByRole('button', { name: 'Encerrar chamado' }),
      ).not.toBeInTheDocument(),
    );
  });
  it('preserva rascunho e recarrega estado se o job encerrou antes da resposta', async () => {
    api.replySupportTicket.mockImplementation(async () => {
      ticket = { ...ticket, status: 'closed' };
      throw new Error('ticket_closed');
    });
    const user = mount();
    await ready();
    await user.type(conversation().getByLabelText('Sua mensagem'), 'Mensagem tardia');
    await user.click(conversation().getByRole('button', { name: 'Enviar mensagem' }));
    expect(await conversation().findByRole('alert')).toHaveTextContent('já foi encerrado');
    await waitFor(() =>
      expect(conversation().queryByLabelText('Sua mensagem')).not.toBeInTheDocument(),
    );
  });
  it('erro de resposta mantém rascunho para tentar novamente; envio vazio não sai', async () => {
    api.replySupportTicket.mockRejectedValue(new Error('Sem conexão'));
    const user = mount();
    await ready();
    const input = conversation().getByLabelText('Sua mensagem');
    expect(conversation().getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(api.replySupportTicket).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Não consegui acessar' } });
    await user.click(conversation().getByRole('button', { name: 'Enviar mensagem' }));
    expect(await conversation().findByRole('alert')).toHaveTextContent('Sem conexão');
    expect(input).toHaveValue('Não consegui acessar');
  });
  it('exibe falha ao encerrar sem perder comandos do chamado', async () => {
    api.closeSupportTicket.mockRejectedValue(new Error('Tente mais tarde'));
    const user = mount();
    await ready();
    await user.click(conversation().getByRole('button', { name: 'Encerrar chamado' }));
    expect(await conversation().findByRole('alert')).toHaveTextContent('Tente mais tarde');
    expect(conversation().getByRole('button', { name: 'Encerrar chamado' })).toBeEnabled();
  });
  it('carrega 50 mensagens anteriores, deduplica e preserva a ordem cronológica', async () => {
    ticket = supportTicket({
      messages: Array.from({ length: 50 }, (_, i) => supportMessage(i + 51)),
      nextBeforeId: 51,
    });
    api.supportTicket.mockImplementation(async (_id, before) =>
      before === 51
        ? supportTicket({ messages: Array.from({ length: 51 }, (_, i) => supportMessage(i + 1)) })
        : ticket,
    );
    const user = mount();
    await ready();
    await user.click(conversation().getByRole('button', { name: 'Carregar mensagens anteriores' }));
    await waitFor(() => expect(conversation().getAllByRole('listitem')).toHaveLength(100));
    expect(api.supportTicket).toHaveBeenCalledWith(7, 51);
    const messages = conversation().getAllByRole('listitem');
    expect(messages[0]).toHaveTextContent('Mensagem 1');
    expect(messages.at(-1)).toHaveTextContent('Mensagem 100');
    expect(
      conversation().queryByRole('button', { name: 'Carregar mensagens anteriores' }),
    ).not.toBeInTheDocument();
  });
  it('erro de página anterior preserva conversa atual e permite tentar de novo', async () => {
    ticket.nextBeforeId = 1;
    api.supportTicket.mockImplementation(async (_id, before) => {
      if (before) throw new Error('Falha anterior');
      return ticket;
    });
    const user = mount();
    await ready();
    await user.click(conversation().getByRole('button', { name: 'Carregar mensagens anteriores' }));
    expect(await conversation().findByRole('alert')).toHaveTextContent('mensagens anteriores');
    expect(conversation().getByText('Mensagem 1')).toBeInTheDocument();
  });
  it('lista paginada tem seleção por URL e filtro volta à primeira página', async () => {
    api.supportTickets.mockImplementation(async (query) => ({
      items: Array.from({ length: query.page === 1 ? 20 : 1 }, (_, i) =>
        supportTicket({ id: i + 7, subject: `Chamado ${i + 7}` }),
      ),
      page: query.page,
      limit: 20,
    }));
    const user = mount({ selected: false });
    await screen.findByText('Chamado 7');
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await waitFor(() => expect(api.supportTickets).toHaveBeenCalledWith({ page: 2, limit: 20 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled());
    await user.click(screen.getByRole('button', { name: /Protocolo #7/ }));
    await ready();
    expect(screen.getByLabelText('Endereço')).toHaveTextContent('/suporte?ticket=7');
    await user.selectOptions(screen.getByLabelText('Filtrar por situação'), 'closed');
    await waitFor(() =>
      expect(api.supportTickets).toHaveBeenCalledWith({ page: 1, limit: 20, status: 'closed' }),
    );
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
  });
  it('página anterior funciona e lista vazia não habilita próxima', async () => {
    api.supportTickets.mockImplementation(async (q) => ({
      items: q.page === 1 ? Array.from({ length: 20 }, (_, i) => supportTicket({ id: i + 1 })) : [],
      page: q.page,
      limit: 20,
    }));
    const user = mount({ selected: false });
    await screen.findByText('Protocolo #1');
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await screen.findByText('Nenhum chamado nesta página.');
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    await screen.findByText('Protocolo #1');
  });
  it.each(['-1', 'abc', '1.5', '9007199254740992'])(
    'ignora ID inválido %s em vez de consultar outro chamado',
    async (id) => {
      mount({ url: `/suporte?ticket=${id}` });
      await screen.findByText('Selecione um chamado para ver a conversa.');
      expect(api.supportTicket).not.toHaveBeenCalled();
    },
  );
  it('erro da consulta pode ser repetido sem conteúdo de outro usuário', async () => {
    api.supportTicket.mockRejectedValueOnce(new Error('Chamado indisponível'));
    const user = mount();
    expect(await conversation().findByRole('alert')).toHaveTextContent('Chamado indisponível');
    await user.click(conversation().getByRole('button', { name: 'Tentar de novo' }));
    await ready();
  });
  it('erro da lista pode ser repetido e uma atualização interrompida preserva a conversa', async () => {
    api.supportTickets.mockRejectedValueOnce(new Error('Fila indisponível'));
    const user = mount();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(api.supportTickets).toHaveBeenCalledTimes(2));
  });
});

describe('atendimento administrativo', () => {
  it('atualização periódica preserva foco, rascunho e escolha de nota interna', async () => {
    const user = mount({ admin: true });
    await ready();
    await user.click(conversation().getByRole('checkbox', { name: /Nota interna/ }));
    const input = conversation().getByLabelText('Texto da nota interna');
    await user.type(input, 'Rascunho enquanto acompanho o chamado');
    ticket = {
      ...ticket,
      status: 'waiting_user',
      messages: [
        ...ticket.messages,
        supportMessage(2, { from: 'support', message: 'Nova resposta pública' }),
      ],
    };
    await act(async () => {
      await clients.at(-1)!.invalidateQueries({ queryKey: ['support', 'admin'] });
    });
    expect(await conversation().findByText('Nova resposta pública')).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Rascunho enquanto acompanho o chamado');
    expect(conversation().getByRole('checkbox', { name: /Nota interna/ })).toBeChecked();
    expect(conversation().getByLabelText('Situação do atendimento')).toHaveValue('waiting_user');
  });

  it('atualização que falha preserva a conversa e o rascunho; tentar novamente recupera os dados', async () => {
    const user = mount({ admin: true });
    await ready();
    const input = conversation().getByLabelText('Sua mensagem');
    await user.type(input, 'Rascunho que precisa ficar');
    api.adminSupportTicket.mockRejectedValueOnce(
      new Error('Consulta temporariamente indisponível'),
    );
    await act(async () => {
      await clients.at(-1)!.invalidateQueries({ queryKey: ['support', 'admin'] });
    });
    expect(await conversation().findByRole('alert')).toHaveTextContent(
      'A conversa não foi atualizada',
    );
    expect(input).toHaveValue('Rascunho que precisa ficar');
    expect(conversation().getByText('Mensagem 1')).toBeInTheDocument();
    await user.click(conversation().getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(conversation().queryByRole('alert')).not.toBeInTheDocument());
    expect(input).toHaveValue('Rascunho que precisa ficar');
  });

  it('separa nota interna e envia flags sem resolver ou notificar o titular', async () => {
    ticket.messages.push(
      supportMessage(2, { from: 'support', internal: true, message: 'Contexto reservado' }),
    );
    const user = mount({ admin: true });
    await ready();
    const note = conversation().getByText('Contexto reservado').closest('li');
    expect(note).toHaveClass('support-internal');
    expect(note).toHaveTextContent('Nota interna · somente equipe');
    await user.click(conversation().getByRole('checkbox', { name: /Nota interna/ }));
    await user.type(
      conversation().getByLabelText('Texto da nota interna'),
      '  Verificar histórico  ',
    );
    expect(conversation().getByRole('button', { name: 'Responder e resolver' })).toBeDisabled();
    await user.click(conversation().getByRole('button', { name: 'Registrar nota interna' }));
    expect(api.adminReplySupportTicket).toHaveBeenCalledWith(7, {
      message: 'Verificar histórico',
      internal: true,
      resolve: false,
    });
    expect(api.replySupportTicket).not.toHaveBeenCalled();
  });
  it('responde publicamente e resolve com o mesmo texto, sem nota interna', async () => {
    api.adminReplySupportTicket.mockImplementation(async () => {
      ticket = { ...ticket, status: 'resolved', resolvedAt: '2026-10-15T12:00:00.000Z' };
      return ticket;
    });
    const user = mount({ admin: true });
    await ready();
    await user.type(conversation().getByLabelText('Sua mensagem'), 'Ajuste concluído');
    await user.click(conversation().getByRole('button', { name: 'Responder e resolver' }));
    expect(api.adminReplySupportTicket).toHaveBeenCalledWith(7, {
      message: 'Ajuste concluído',
      internal: false,
      resolve: true,
    });
    await waitFor(() =>
      expect(conversation().getByLabelText('Situação do atendimento')).toBeDisabled(),
    );
    expect(conversation().getByText(/em até 5 dias/)).toBeInTheDocument();
  });
  it('altera prioridade e situação sem permitir escolher resolução sem resposta', async () => {
    const user = mount({ admin: true });
    await ready();
    await user.selectOptions(conversation().getByLabelText('Prioridade'), 'critical');
    await waitFor(() =>
      expect(api.adminUpdateSupportTicket).toHaveBeenCalledWith(7, { priority: 'critical' }),
    );
    await waitFor(() =>
      expect(conversation().getByLabelText('Prioridade')).toHaveValue('critical'),
    );
    await user.selectOptions(
      conversation().getByLabelText('Situação do atendimento'),
      'waiting_user',
    );
    await waitFor(() =>
      expect(api.adminUpdateSupportTicket).toHaveBeenCalledWith(7, { status: 'waiting_user' }),
    );
    expect(conversation().getByLabelText('Situação do atendimento')).not.toContainHTML(
      '<option value="resolved">',
    );
    expect(
      conversation().queryByRole('button', { name: 'Encerrar chamado' }),
    ).not.toBeInTheDocument();
  });
  it('erro administrativo permanece visível sem apagar o texto', async () => {
    api.adminUpdateSupportTicket.mockRejectedValue(new Error('Atualização recusada'));
    const user = mount({ admin: true });
    await ready();
    await user.selectOptions(conversation().getByLabelText('Prioridade'), 'high');
    expect(await conversation().findByRole('alert')).toHaveTextContent('Atualização recusada');
    expect(conversation().getByLabelText('Prioridade')).toHaveValue('medium');
  });
  it('mostra primeira resposta pública e histórico de encerrado sem aceitar mudanças', async () => {
    ticket = supportTicket({ status: 'closed', firstResponseAt: '2026-10-15T12:00:00.000Z' });
    mount({ admin: true });
    await ready();
    expect(conversation().getByText(/Primeira resposta pública:/)).toBeInTheDocument();
    expect(conversation().getByLabelText('Prioridade')).toBeDisabled();
    expect(conversation().getByLabelText('Situação do atendimento')).toBeDisabled();
    expect(conversation().queryByLabelText('Sua mensagem')).not.toBeInTheDocument();
  });
  it('titular removido mantém histórico e explica por que o atendimento não aceita mutações', async () => {
    ticket.ownerDeleted = true;
    mount({ admin: true });
    await ready();
    expect(conversation().getByText(/Conta do titular removida/)).toBeInTheDocument();
    expect(conversation().getByText('Mensagem 1')).toBeInTheDocument();
    expect(conversation().getByLabelText('Prioridade')).toBeDisabled();
    expect(conversation().getByLabelText('Situação do atendimento')).toBeDisabled();
    expect(conversation().queryByLabelText('Sua mensagem')).not.toBeInTheDocument();
  });
  it('seleção administrativa mantém destino #suporte e usa as consultas administrativas', async () => {
    const user = mount({ admin: true, selected: false });
    await user.click(await screen.findByRole('button', { name: /Protocolo #7/ }));
    await ready();
    expect(screen.getByLabelText('Endereço')).toHaveTextContent('/admin?ticket=7#suporte');
    expect(api.adminSupportTickets).toHaveBeenCalledWith({ page: 1, limit: 20 });
    expect(api.adminSupportTicket).toHaveBeenCalledWith(7, undefined);
    expect(api.supportTicket).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Abrir chamado' })).not.toBeInTheDocument();
  });
  it('carrega janela administrativa anterior incluindo notas internas', async () => {
    ticket.nextBeforeId = 1;
    api.adminSupportTicket.mockImplementation(async (_id, before) =>
      before
        ? supportTicket({
            messages: [supportMessage(0, { internal: true, message: 'Nota antiga' })],
          })
        : ticket,
    );
    const user = mount({ admin: true });
    await ready();
    await user.click(conversation().getByRole('button', { name: 'Carregar mensagens anteriores' }));
    expect(await conversation().findByText('Nota antiga')).toBeInTheDocument();
    expect(api.adminSupportTicket).toHaveBeenCalledWith(7, 1);
  });
  it('envio em andamento bloqueia ações concorrentes da conversa', async () => {
    api.adminReplySupportTicket.mockImplementation(() => new Promise(() => undefined));
    const user = mount({ admin: true });
    await ready();
    const input = conversation().getByLabelText('Sua mensagem');
    await user.type(input, 'Mensagem única');
    fireEvent.submit(input.closest('form')!);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(api.adminReplySupportTicket).toHaveBeenCalledTimes(1));
    expect(conversation().getByLabelText('Prioridade')).toBeDisabled();
    expect(conversation().getByRole('button', { name: 'Responder e resolver' })).toBeDisabled();
  });
});
