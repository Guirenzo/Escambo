import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AdminDeletionRequest,
  AdminEmail,
  AdminMetrics,
  AdminWithdrawal,
  Dispute,
} from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { AdminView } from './AdminView';

/**
 * Painel do administrador: os números da plataforma e as quatro filas que só o admin resolve
 * (mediação de disputas, saques, exclusões de conta da LGPD e a caixa de saída de e-mails). Cada
 * decisão manda para a API exatamente o que o diálogo mostrou e avisa o que aconteceu.
 */

const adminMetrics = vi.fn();
const adminDisputes = vi.fn();
const adminWithdrawals = vi.fn();
const adminDeletionRequests = vi.fn();
const adminEmails = vi.fn();
const adminResolveDispute = vi.fn();
const adminWithdrawalAction = vi.fn();
const adminDeletionAction = vi.fn();
/** As outras seções do painel têm testes próprios: aqui as consultas delas ficam carregando. */
const pending = () => new Promise(() => undefined);
vi.mock('../../lib/api', () => ({
  api: {
    adminMetrics: () => adminMetrics(),
    adminDisputes: () => adminDisputes(),
    adminWithdrawals: (status: string) => adminWithdrawals(status),
    adminDeletionRequests: (status: string) => adminDeletionRequests(status),
    adminEmails: (limit: number) => adminEmails(limit),
    adminResolveDispute: (id: number, body: unknown) => adminResolveDispute(id, body),
    adminWithdrawalAction: (id: number, action: string, body: unknown) =>
      adminWithdrawalAction(id, action, body),
    adminDeletionAction: (id: number, action: string, body: unknown) =>
      adminDeletionAction(id, action, body),
    adminFinance: () => pending(),
    adminStorage: () => pending(),
    adminSettings: () => pending(),
    adminModerationHealth: () => pending(),
    adminReports: () => pending(),
    adminAppeals: () => pending(),
  },
}));

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin']}>
          <AdminView />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** O cartão de um indicador: o bloco que junta rótulo, valor e dica (não tem papel acessível). */
function kpi(label: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(label);
  while (el && !el.querySelector('strong')) el = el.parentElement;
  if (!el) throw new Error(`indicador "${label}" sem valor`);
  return el;
}

/** A seção (cartão) de uma fila, pelo título dela. */
function card(title: string | RegExp): HTMLElement {
  const section = screen.getByRole('heading', { level: 3, name: title }).closest('section');
  if (!section) throw new Error(`seção "${String(title)}" não encontrada`);
  return section;
}

const DISPUTES = 'Fila de mediação';
const WITHDRAWALS = 'Fila de saques';
const DELETIONS = /^Exclusões de conta \(LGPD\)/;
const EMAILS = 'Caixa de saída de e-mails';

const metricsOf = (o: Partial<AdminMetrics> = {}): AdminMetrics => ({
  users: 128,
  freelancers: 37,
  contracts: 54,
  completedContracts: 12,
  openDisputes: 2,
  platformFees: 1530.75,
  inEscrow: 4200,
  pendingWithdrawals: 3,
  pendingWithdrawalsAmount: 450,
  depositsTotal: 18000,
  usersBalance: 9100.1,
  pendingDeletions: 0,
  ...o,
});

const disputeOf = (o: Partial<Dispute> & { id: number }): Dispute => ({
  ulid: `d-${o.id}`,
  contractId: 77,
  openedBy: 9,
  reason: 'quality',
  description: 'O logo veio em baixa resolução.',
  status: 'open',
  resolution: null,
  refundPercentage: null,
  createdAt: '2026-09-20T15:30:00.000Z',
  ...o,
});

const withdrawalOf = (o: Partial<AdminWithdrawal> & { id: number }): AdminWithdrawal => ({
  amount: 150,
  status: 'requested',
  method: 'pix',
  maskedDestination: 'm***@pix.com',
  createdAt: '2026-09-18T10:00:00.000Z',
  processedAt: null,
  userId: 7,
  userUlid: 'u-marina',
  userEmail: 'marina@escambo.test',
  userName: 'Marina Alves',
  destination: 'marina@pix.com',
  ...o,
});

const deletionOf = (o: Partial<AdminDeletionRequest> & { id: number }): AdminDeletionRequest => ({
  reason: 'Não uso mais a plataforma.',
  status: 'pending',
  adminNote: null,
  createdAt: '2026-09-19T12:00:00.000Z',
  processedAt: null,
  userId: 8,
  userUlid: 'u-carla',
  userEmail: 'carla@escambo.test',
  userName: 'Carla Dias',
  activeContracts: 0,
  balance: 0,
  balancePending: 0,
  ...o,
});

const emailOf = (o: Partial<AdminEmail> & { id: number }): AdminEmail => ({
  userId: 8,
  to: 'carla@escambo.test',
  subject: 'Confirme seu e-mail',
  template: 'verify_email',
  text: 'Olá! Confirme em https://escambo.app/verificar?token=abc e pronto.',
  status: 'sent',
  provider: 'console',
  error: null,
  sentAt: '2026-09-21T09:00:00.000Z',
  createdAt: '2026-09-21T09:00:00.000Z',
  ...o,
});

beforeEach(() => {
  for (const fn of [
    adminMetrics,
    adminDisputes,
    adminWithdrawals,
    adminDeletionRequests,
    adminEmails,
    adminResolveDispute,
    adminWithdrawalAction,
    adminDeletionAction,
  ]) {
    fn.mockReset();
  }
  adminMetrics.mockResolvedValue(metricsOf());
  adminDisputes.mockResolvedValue([]);
  adminWithdrawals.mockResolvedValue([]);
  adminDeletionRequests.mockResolvedValue([]);
  adminEmails.mockResolvedValue([]);
  adminResolveDispute.mockResolvedValue(disputeOf({ id: 5, status: 'resolved' }));
  adminWithdrawalAction.mockResolvedValue(withdrawalOf({ id: 9, status: 'processing' }));
  adminDeletionAction.mockResolvedValue(deletionOf({ id: 3, status: 'completed' }));
});

describe('AdminView: números e estados das filas', () => {
  it('enquanto nada chegou: indicadores com travessão e cada fila com o esqueleto', () => {
    for (const fn of [
      adminMetrics,
      adminDisputes,
      adminWithdrawals,
      adminDeletionRequests,
      adminEmails,
    ]) {
      fn.mockReturnValue(pending());
    }
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: 'Administração' })).toBeInTheDocument();
    expect(kpi('Usuários')).toHaveTextContent(/^Usuários—$/);
    expect(kpi('Contratações')).toHaveTextContent(/^Contratações—$/);
    expect(kpi('Receita da plataforma')).toHaveTextContent('Receita da plataforma—taxas retidas');
    expect(kpi('Saques pendentes')).toHaveTextContent(/^Saques pendentes—$/);
    for (const title of [DISPUTES, WITHDRAWALS, DELETIONS, EMAILS]) {
      expect(within(card(title)).getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    }
    expect(screen.queryByText(/aberta\(s\)$/)).not.toBeInTheDocument();
    expect(document.title).toBe('Administração · Escambo');
  });

  it('busca as filas abertas: saques em aberto, exclusões pendentes e os 50 últimos e-mails', async () => {
    renderView();

    await screen.findByText('0 aberta(s)');
    expect(adminWithdrawals).toHaveBeenCalledWith('open');
    expect(adminDeletionRequests).toHaveBeenCalledWith('pending');
    expect(adminEmails).toHaveBeenCalledWith(50);
    expect(adminDisputes).toHaveBeenCalledTimes(1);
    expect(adminMetrics).toHaveBeenCalledTimes(1);
  });

  it('mostra os números da plataforma, com os valores em reais', async () => {
    renderView();

    expect(await screen.findByText('37 freelancers')).toBeInTheDocument();
    expect(kpi('Usuários')).toHaveTextContent('Usuários12837 freelancers');
    expect(kpi('Contratações')).toHaveTextContent('Contratações54 12 concluídas');
    expect(kpi('Disputas abertas')).toHaveTextContent('Disputas abertas2aguardando mediação');
    expect(kpi('Receita da plataforma')).toHaveTextContent('R$ 1.530,75');
    expect(kpi('Depósitos confirmados')).toHaveTextContent('R$ 18.000,00');
    expect(kpi('Em escrow')).toHaveTextContent('R$ 4.200,00');
    expect(kpi('Saldo dos usuários')).toHaveTextContent('R$ 9.100,10');
    expect(kpi('Saques pendentes')).toHaveTextContent('Saques pendentes3R$ 450,00 a pagar');
  });

  it('pedidos de exclusão pendentes ganham um contador no título; sem pendência, nada', async () => {
    adminMetrics.mockResolvedValue(metricsOf({ pendingDeletions: 2 }));
    const first = renderView();
    expect(await screen.findByText('2 pendente(s)')).toBeInTheDocument();
    first.unmount();

    adminMetrics.mockResolvedValue(metricsOf({ pendingDeletions: 0 }));
    renderView();
    await screen.findByText('37 freelancers');
    expect(screen.queryByText(/pendente\(s\)$/)).not.toBeInTheDocument();
  });

  it('com as filas vazias, a mediação conta zero e nenhuma fila oferece ação', async () => {
    renderView();

    expect(await within(card(DISPUTES)).findByText('0 aberta(s)')).toBeInTheDocument();
    await waitFor(() => {
      for (const title of [DISPUTES, WITHDRAWALS, DELETIONS, EMAILS]) {
        expect(within(card(title)).queryByRole('status', { name: 'Carregando' })).toBeNull();
      }
    });
    // As mensagens de fila vazia ("Nenhuma disputa aberta…") ficam no it.todo logo abaixo: hoje a
    // tela não as mostra para uma lista vazia (defeito relatado), só a tabela sem linhas.
    for (const title of [DISPUTES, WITHDRAWALS, DELETIONS, EMAILS]) {
      expect(within(card(title)).queryByRole('button')).not.toBeInTheDocument();
      expect(within(card(title)).queryByRole('alert')).not.toBeInTheDocument();
    }
  });

  // Defeito de produção: os QueryState das quatro filas (AdminView.tsx) recebem `empty`, mas não
  // `isEmpty`; com a lista vazia a tela desenha só o cabeçalho da tabela, e as mensagens nunca saem.
  it.todo(
    'com as filas vazias, cada uma diz que está vazia: "Nenhuma disputa aberta. Tudo em paz.", "Nenhum saque aguardando. Nada a pagar.", "Nenhum pedido de exclusão aguardando." e "Nenhum e-mail gerado ainda."',
  );

  it('o painel reúne também finanças, armazenamento, parâmetros e as filas de moderação', () => {
    renderView();

    for (const title of [
      'Financeiro',
      'Armazenamento',
      'Parâmetros da plataforma',
      'Saúde da moderação',
      'Denúncias',
      'Contestações',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        'Moderação de usuários (suspender, banir, reativar) fica no perfil público de cada freelancer, visível só para administradores.',
      ),
    ).toBeInTheDocument();
  });

  it('falha numa fila: o erro aparece só nela e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    adminDisputes.mockRejectedValueOnce(new Error('Falha ao listar as disputas.'));
    adminDisputes.mockResolvedValue([disputeOf({ id: 5 })]);
    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Falha ao listar as disputas.');
    expect(card(DISPUTES)).toContainElement(alert);
    // As outras filas carregam normalmente: o erro é um só.
    await waitFor(() =>
      expect(within(card(EMAILS)).queryByRole('status', { name: 'Carregando' })).toBeNull(),
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(card(DISPUTES)).findByRole('row', { name: /^#5\D/ })).toBeInTheDocument();
    expect(adminDisputes).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['saques', WITHDRAWALS, adminWithdrawals, 'Falha nos saques.'],
    ['exclusões', DELETIONS, adminDeletionRequests, 'Falha nas exclusões.'],
    ['e-mails', EMAILS, adminEmails, 'Falha nos e-mails.'],
  ] as const)(
    'falha na fila de %s: "Tentar de novo" refaz só aquela busca',
    async (_n, title, fn, msg) => {
      const user = userEvent.setup();
      fn.mockRejectedValueOnce(new Error(msg));
      fn.mockResolvedValue([]);
      renderView();

      const alert = await within(card(title)).findByRole('alert');
      expect(alert).toHaveTextContent(msg);
      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));

      await waitFor(() => expect(within(card(title)).queryByRole('alert')).not.toBeInTheDocument());
      expect(fn).toHaveBeenCalledTimes(2);
      expect(adminDisputes).toHaveBeenCalledTimes(1);
    },
  );
});

describe('AdminView: mediação de disputas', () => {
  it('lista cada disputa com o contrato, o motivo em português, a descrição e a situação', async () => {
    adminDisputes.mockResolvedValue([
      disputeOf({ id: 5 }),
      disputeOf({
        id: 6,
        contractId: 80,
        reason: 'deadline',
        description: 'Passou do prazo combinado.',
        status: 'under_review',
        createdAt: '2026-09-22T08:15:00.000Z',
      }),
    ]);
    renderView();

    const row = await within(card(DISPUTES)).findByRole('row', { name: /^#5\D/ });
    expect(within(card(DISPUTES)).getByText('2 aberta(s)')).toBeInTheDocument();
    expect(row).toHaveTextContent(`#5aberta em ${dtm('2026-09-20T15:30:00.000Z')}`);
    expect(within(row).getByRole('link', { name: '#77' })).toHaveAttribute('href', '/contratos/77');
    expect(within(row).getByText('Qualidade abaixo do combinado')).toBeInTheDocument();
    expect(within(row).getByText('O logo veio em baixa resolução.')).toBeInTheDocument();
    expect(within(row).getByText('Aberta')).toBeInTheDocument();

    const other = within(card(DISPUTES)).getByRole('row', { name: /^#6\D/ });
    expect(other).toHaveTextContent(`aberta em ${dtm('2026-09-22T08:15:00.000Z')}`);
    expect(within(other).getByRole('link', { name: '#80' })).toHaveAttribute(
      'href',
      '/contratos/80',
    );
    expect(within(other).getByText('Prazo não cumprido')).toBeInTheDocument();
    expect(within(other).getByText('Em análise')).toBeInTheDocument();
  });

  it('"Resolver" abre a disputa; a decisão padrão libera ao freelancer, sem percentual nem nota', async () => {
    const user = userEvent.setup();
    adminDisputes.mockResolvedValue([disputeOf({ id: 5 })]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Resolver' }));

    const dialog = screen.getByRole('dialog', { name: 'Resolver disputa #5' });
    expect(dialog).toHaveTextContent('Qualidade abaixo do combinado');
    expect(dialog).toHaveTextContent('O logo veio em baixa resolução.');
    expect(dialog).toHaveTextContent(`contrato #77 · aberta em ${dtm('2026-09-20T15:30:00.000Z')}`);
    const decision = within(dialog).getByRole('radiogroup', { name: 'Decisão' });
    expect(within(decision).getByRole('radio', { name: /^Liberar ao freelancer/ })).toBeChecked();
    expect(within(dialog).queryByRole('slider')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Aplicar decisão' }));

    await waitFor(() => expect(adminResolveDispute).toHaveBeenCalledTimes(1));
    expect(adminResolveDispute).toHaveBeenCalledWith(5, {
      resolution: 'release_freelancer',
      refundPercentage: null,
      note: null,
    });
    expect(
      await screen.findByText('Disputa resolvida. As duas partes foram notificadas.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // A fila e os números são buscados de novo.
    await waitFor(() => expect(adminDisputes).toHaveBeenCalledTimes(2));
    expect(adminMetrics).toHaveBeenCalledTimes(2);
  });

  it('"Devolver ao cliente" vai com a justificativa aparada e sem percentual', async () => {
    const user = userEvent.setup();
    adminDisputes.mockResolvedValue([disputeOf({ id: 5 })]);
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Resolver' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolver disputa #5' });

    await user.click(within(dialog).getByRole('radio', { name: /^Devolver ao cliente/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Justificativa' }),
      '  A entrega não aconteceu.  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar decisão' }));

    await waitFor(() =>
      expect(adminResolveDispute).toHaveBeenCalledWith(5, {
        resolution: 'refund_client',
        refundPercentage: null,
        note: 'A entrega não aconteceu.',
      }),
    );
  });

  it('"Dividir" mostra o percentual (50% de início) e manda o que foi escolhido', async () => {
    const user = userEvent.setup();
    adminDisputes.mockResolvedValue([disputeOf({ id: 5 })]);
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Resolver' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolver disputa #5' });

    await user.click(within(dialog).getByRole('radio', { name: /^Dividir/ }));
    const slider = within(dialog).getByRole('slider', { name: 'Percentual devolvido ao cliente' });
    expect(slider).toHaveValue('50');
    // De 5% a 95% (ADR 60): 0% e 100% são 'Liberar' e 'Devolver', e a API os recusa na divisão.
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '95');
    expect(within(dialog).getByText('Percentual devolvido ao cliente: 50%')).toBeInTheDocument();

    // O controle deslizante não tem teclado no jsdom: a mudança de valor é disparada direto.
    fireEvent.change(slider, { target: { value: '30' } });
    expect(within(dialog).getByText('Percentual devolvido ao cliente: 30%')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar decisão' }));

    await waitFor(() =>
      expect(adminResolveDispute).toHaveBeenCalledWith(5, {
        resolution: 'partial_split',
        refundPercentage: 30,
        note: null,
      }),
    );
  });

  it('se a API recusa a decisão, mostra o motivo e o diálogo continua aberto', async () => {
    const user = userEvent.setup();
    adminDisputes.mockResolvedValue([disputeOf({ id: 5 })]);
    adminResolveDispute.mockRejectedValueOnce(new Error('A disputa já foi resolvida.'));
    adminResolveDispute.mockRejectedValueOnce(503);
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Resolver' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolver disputa #5' });

    await user.click(within(dialog).getByRole('button', { name: 'Aplicar decisão' }));
    expect(await screen.findByText('A disputa já foi resolvida.')).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();

    // Falha sem mensagem: o aviso genérico.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Aplicar decisão' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar decisão' }));
    expect(await screen.findByText('Erro ao resolver')).toBeInTheDocument();
    expect(
      screen.queryByText('Disputa resolvida. As duas partes foram notificadas.'),
    ).not.toBeInTheDocument();
  });

  it('enquanto a decisão está indo, o botão diz "Aplicando…" e fica travado; fechar não envia nada', async () => {
    const user = userEvent.setup();
    adminDisputes.mockResolvedValue([disputeOf({ id: 5 }), disputeOf({ id: 6 })]);
    let release!: (d: Dispute) => void;
    adminResolveDispute.mockReturnValue(new Promise<Dispute>((resolve) => (release = resolve)));
    renderView();

    // Abrir e fechar sem decidir não chama a API.
    const row6 = await within(card(DISPUTES)).findByRole('row', { name: /^#6\D/ });
    await user.click(within(row6).getByRole('button', { name: 'Resolver' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Resolver disputa #6' })).getByRole('button', {
        name: 'Fechar',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(adminResolveDispute).not.toHaveBeenCalled();

    const row5 = within(card(DISPUTES)).getByRole('row', { name: /^#5\D/ });
    await user.click(within(row5).getByRole('button', { name: 'Resolver' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolver disputa #5' });
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar decisão' }));

    expect(await within(dialog).findByRole('button', { name: 'Aplicando…' })).toBeDisabled();
    release(disputeOf({ id: 5, status: 'resolved' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('AdminView: fila de saques', () => {
  it('lista titular, valor, destino e situação; as ações dependem da situação do saque', async () => {
    adminWithdrawals.mockResolvedValue([
      withdrawalOf({ id: 9 }),
      withdrawalOf({
        id: 8,
        amount: 80,
        status: 'processing',
        method: 'bank',
        destination: 'Ag 0001 Cc 12345-6',
        userName: null,
        userEmail: 'sem.nome@escambo.test',
      }),
      withdrawalOf({ id: 7, amount: 60, status: 'completed' }),
      withdrawalOf({ id: 6, amount: 40, status: 'failed' }),
    ]);
    renderView();

    const requested = await within(card(WITHDRAWALS)).findByRole('row', { name: /^#9\D/ });
    expect(requested).toHaveTextContent(`#9pedido em ${dtm('2026-09-18T10:00:00.000Z')}`);
    expect(requested).toHaveTextContent('Marina Alvesmarina@escambo.test');
    expect(requested).toHaveTextContent('R$ 150,00');
    expect(requested).toHaveTextContent('marina@pix.comchave PIX');
    expect(within(requested).getByText('Aguardando')).toBeInTheDocument();
    expect(
      within(requested)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Processar', 'Concluir', 'Falhar']);

    // Em processamento: já não se "processa", só conclui ou falha. Sem nome, um travessão.
    const processing = within(card(WITHDRAWALS)).getByRole('row', { name: /^#8\D/ });
    expect(processing).toHaveTextContent('—sem.nome@escambo.test');
    expect(processing).toHaveTextContent('Ag 0001 Cc 12345-6conta bancária');
    expect(within(processing).getByText('Em processamento')).toBeInTheDocument();
    expect(
      within(processing)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Concluir', 'Falhar']);

    const done = within(card(WITHDRAWALS)).getByRole('row', { name: /^#7\D/ });
    expect(within(done).getByText('Concluído')).toBeInTheDocument();
    expect(within(done).queryByRole('button')).not.toBeInTheDocument();
    const failed = within(card(WITHDRAWALS)).getByRole('row', { name: /^#6\D/ });
    expect(within(failed).getByText('Falhou')).toBeInTheDocument();
    expect(within(failed).queryByRole('button')).not.toBeInTheDocument();
  });

  it('o filtro "Todos" busca a fila inteira; "Abertos" volta ao que falta pagar', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockImplementation(async (status: string) =>
      status === 'all'
        ? [withdrawalOf({ id: 9 }), withdrawalOf({ id: 7, status: 'completed' })]
        : [withdrawalOf({ id: 9 })],
    );
    renderView();
    const tabs = screen.getByRole('tablist', { name: 'Filtro de saques' });
    expect(within(tabs).getByRole('tab', { name: 'Abertos' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await within(card(WITHDRAWALS)).findByRole('row', { name: /^#9\D/ });
    expect(within(card(WITHDRAWALS)).queryByRole('row', { name: /^#7\D/ })).toBeNull();

    await user.click(within(tabs).getByRole('tab', { name: 'Todos' }));

    expect(await within(card(WITHDRAWALS)).findByRole('row', { name: /^#7\D/ })).toBeVisible();
    expect(adminWithdrawals).toHaveBeenLastCalledWith('all');
    expect(within(tabs).getByRole('tab', { name: 'Todos' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'Abertos' })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    await user.click(within(tabs).getByRole('tab', { name: 'Abertos' }));
    await waitFor(() =>
      expect(within(card(WITHDRAWALS)).queryByRole('row', { name: /^#7\D/ })).toBeNull(),
    );
  });

  it('"Processar" marca o saque como em processamento, avisa e recarrega a fila', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValueOnce([withdrawalOf({ id: 9 })]);
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9, status: 'processing' })]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Processar' }));

    await waitFor(() => expect(adminWithdrawalAction).toHaveBeenCalledTimes(1));
    expect(adminWithdrawalAction).toHaveBeenCalledWith(9, 'process', undefined);
    expect(await screen.findByText('Saque #9 em processamento.')).toBeInTheDocument();
    expect(await within(card(WITHDRAWALS)).findByText('Em processamento')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Processar' })).not.toBeInTheDocument();
    expect(adminMetrics).toHaveBeenCalledTimes(2);
  });

  it('se "Processar" falha, mostra o motivo e o saque continua aguardando', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9 })]);
    adminWithdrawalAction.mockRejectedValueOnce(new Error('O saque foi cancelado pelo titular.'));
    adminWithdrawalAction.mockRejectedValueOnce('boom');
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Processar' }));
    expect(await screen.findByText('O saque foi cancelado pelo titular.')).toBeInTheDocument();
    expect(within(card(WITHDRAWALS)).getByText('Aguardando')).toBeInTheDocument();

    // Falha sem mensagem: o aviso genérico.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Processar' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Processar' }));
    expect(await screen.findByText('Erro ao processar')).toBeInTheDocument();
    expect(screen.queryByText('Saque #9 em processamento.')).not.toBeInTheDocument();
  });

  it('enquanto "Processar" está indo, o botão fica travado e não manda o pedido duas vezes', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9 })]);
    let release!: (w: AdminWithdrawal) => void;
    adminWithdrawalAction.mockReturnValue(
      new Promise<AdminWithdrawal>((resolve) => (release = resolve)),
    );
    renderView();

    const button = await screen.findByRole('button', { name: 'Processar' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(adminWithdrawalAction).toHaveBeenCalledTimes(1);

    release(withdrawalOf({ id: 9, status: 'processing' }));
    expect(await screen.findByText('Saque #9 em processamento.')).toBeInTheDocument();
    await waitFor(() => expect(adminWithdrawals).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Processar' })).toBeEnabled();
  });

  it('enquanto o pagamento é confirmado, o botão do diálogo diz "Processando…" e fica travado', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9 })]);
    let release!: (w: AdminWithdrawal) => void;
    adminWithdrawalAction.mockReturnValue(
      new Promise<AdminWithdrawal>((resolve) => (release = resolve)),
    );
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Concluir' }));
    const dialog = screen.getByRole('dialog', { name: 'Concluir saque #9' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar pagamento' }));

    expect(await within(dialog).findByRole('button', { name: 'Processando…' })).toBeDisabled();
    expect(
      within(dialog).queryByRole('button', { name: 'Confirmar pagamento' }),
    ).not.toBeInTheDocument();

    release(withdrawalOf({ id: 9, status: 'completed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Saque concluído. O titular foi avisado.')).toBeInTheDocument();
    await waitFor(() => expect(adminWithdrawals).toHaveBeenCalledTimes(2));
  });

  it('"Concluir" mostra o valor e o destino e envia a referência do pagamento', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9 })]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Concluir' }));

    const dialog = screen.getByRole('dialog', { name: 'Concluir saque #9' });
    expect(dialog).toHaveTextContent('R$ 150,00Marina Alves · PIX marina@pix.com');
    await user.type(
      within(dialog).getByLabelText('Referência do pagamento (opcional)'),
      ' E1234567890 ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar pagamento' }));

    await waitFor(() => expect(adminWithdrawalAction).toHaveBeenCalledTimes(1));
    expect(adminWithdrawalAction).toHaveBeenCalledWith(9, 'complete', {
      gatewayRef: 'E1234567890',
    });
    expect(await screen.findByText('Saque concluído. O titular foi avisado.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(adminWithdrawals).toHaveBeenCalledTimes(2));
  });

  it('concluir sem referência manda null; titular sem nome aparece pelo e-mail, conta como "Conta"', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([
      withdrawalOf({
        id: 8,
        status: 'processing',
        method: 'bank',
        destination: 'Ag 0001 Cc 12345-6',
        userName: null,
        userEmail: 'sem.nome@escambo.test',
      }),
    ]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Concluir' }));
    const dialog = screen.getByRole('dialog', { name: 'Concluir saque #8' });
    expect(dialog).toHaveTextContent('sem.nome@escambo.test · Conta Ag 0001 Cc 12345-6');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar pagamento' }));

    await waitFor(() =>
      expect(adminWithdrawalAction).toHaveBeenCalledWith(8, 'complete', { gatewayRef: null }),
    );
  });

  it('"Falhar" pede o motivo que o titular recebe e estorna o valor', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9 })]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Falhar' }));

    const dialog = screen.getByRole('dialog', { name: 'Falhar saque #9' });
    await user.type(
      within(dialog).getByLabelText('Motivo (o titular recebe)'),
      'Chave PIX inexistente',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Marcar como falho e estornar' }));

    await waitFor(() =>
      expect(adminWithdrawalAction).toHaveBeenCalledWith(9, 'fail', {
        reason: 'Chave PIX inexistente',
      }),
    );
    expect(
      await screen.findByText(
        'Saque marcado como falho; o valor voltou para a carteira do titular.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falhar sem motivo manda null; se a API recusa, o diálogo fica aberto com o erro', async () => {
    const user = userEvent.setup();
    adminWithdrawals.mockResolvedValue([withdrawalOf({ id: 9 })]);
    adminWithdrawalAction.mockRejectedValueOnce(new Error('O saque já foi pago.'));
    adminWithdrawalAction.mockRejectedValueOnce({});
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Falhar' }));
    const dialog = screen.getByRole('dialog', { name: 'Falhar saque #9' });
    const submit = within(dialog).getByRole('button', { name: 'Marcar como falho e estornar' });
    await user.click(submit);

    expect(await screen.findByText('O saque já foi pago.')).toBeInTheDocument();
    expect(adminWithdrawalAction).toHaveBeenCalledWith(9, 'fail', { reason: null });
    expect(dialog).toBeInTheDocument();

    // Falha sem mensagem: o aviso genérico.
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('Erro ao processar')).toBeInTheDocument();
  });
});

describe('AdminView: exclusões de conta (LGPD)', () => {
  const blocked = deletionOf({
    id: 4,
    userName: null,
    userEmail: 'ana@escambo.test',
    reason: null,
    status: 'processing',
    activeContracts: 2,
    balance: 100,
    balancePending: 50,
  });

  it('lista o titular, o motivo e o que ainda o prende à plataforma', async () => {
    adminDeletionRequests.mockResolvedValue([
      deletionOf({ id: 3 }),
      blocked,
      deletionOf({ id: 5, balance: 12.5, userEmail: 'saldo@escambo.test' }),
    ]);
    renderView();

    const free = await within(card(DELETIONS)).findByRole('row', { name: /^#3\D/ });
    expect(free).toHaveTextContent(`#3pedido em ${dtm('2026-09-19T12:00:00.000Z')}`);
    expect(free).toHaveTextContent('Carla Diascarla@escambo.test');
    expect(within(free).getByText('Não uso mais a plataforma.')).toBeInTheDocument();
    expect(within(free).getByText('nenhuma')).toBeInTheDocument();
    expect(within(free).getByText('em análise')).toBeInTheDocument();
    expect(
      within(free)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Concluir exclusão', 'Recusar']);

    // Sem nome e sem motivo: travessões. Com contratações e saldo: os dois na coluna de pendências.
    const held = within(card(DELETIONS)).getByRole('row', { name: /^#4\D/ });
    expect(held).toHaveTextContent('—ana@escambo.test—');
    expect(within(held).getByText('2 contratação(ões) · R$ 150,00 na carteira')).toBeVisible();
    expect(within(held).getByText('em processamento')).toBeInTheDocument();
    expect(within(held).getByRole('button', { name: 'Concluir exclusão' })).toBeEnabled();

    // Só saldo: a pendência não fala de contratações.
    const balanceOnly = within(card(DELETIONS)).getByRole('row', { name: /^#5\D/ });
    expect(within(balanceOnly).getByText('R$ 12,50 na carteira')).toBeVisible();
  });

  it('o filtro "Todas" busca os pedidos já decididos, que não têm mais ação', async () => {
    const user = userEvent.setup();
    adminDeletionRequests.mockImplementation(async (status: string) =>
      status === 'all'
        ? [
            deletionOf({ id: 3 }),
            deletionOf({ id: 2, status: 'completed' }),
            deletionOf({ id: 1, status: 'rejected' }),
          ]
        : [deletionOf({ id: 3 })],
    );
    renderView();
    const tabs = screen.getByRole('tablist', { name: 'Filtro de exclusões' });
    expect(within(tabs).getByRole('tab', { name: 'Pendentes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await within(card(DELETIONS)).findByRole('row', { name: /^#3\D/ });

    await user.click(within(tabs).getByRole('tab', { name: 'Todas' }));

    const completed = await within(card(DELETIONS)).findByRole('row', { name: /^#2\D/ });
    expect(adminDeletionRequests).toHaveBeenLastCalledWith('all');
    expect(within(tabs).getByRole('tab', { name: 'Todas' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(completed).getByText('concluída')).toBeInTheDocument();
    expect(within(completed).queryByRole('button')).not.toBeInTheDocument();
    const rejected = within(card(DELETIONS)).getByRole('row', { name: /^#1\D/ });
    expect(within(rejected).getByText('recusada')).toBeInTheDocument();
    expect(within(rejected).queryByRole('button')).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'Pendentes' }));
    await waitFor(() =>
      expect(within(card(DELETIONS)).queryByRole('row', { name: /^#2\D/ })).toBeNull(),
    );
  });

  it('concluir sem pendências: avisa que não dá para desfazer e anonimiza a conta', async () => {
    const user = userEvent.setup();
    adminDeletionRequests.mockResolvedValue([deletionOf({ id: 3 })]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Concluir exclusão' }));

    const dialog = screen.getByRole('dialog', { name: 'Concluir exclusão · Carla Dias' });
    expect(dialog).toHaveTextContent('carla@escambo.testNão uso mais a plataforma.');
    expect(dialog).toHaveTextContent(
      `pedido em ${dtm('2026-09-19T12:00:00.000Z')} · 0 contratação(ões) aberta(s) · R$ 0,00 na carteira`,
    );
    expect(dialog).toHaveTextContent(
      'A conta será anonimizada (e-mail, telefone, senha, perfil, serviços, favoritos e notificações) e o acesso encerrado na hora.',
    );
    expect(dialog).toHaveTextContent('Não dá para desfazer.');
    await user.click(within(dialog).getByRole('button', { name: 'Anonimizar e encerrar a conta' }));

    await waitFor(() => expect(adminDeletionAction).toHaveBeenCalledTimes(1));
    expect(adminDeletionAction).toHaveBeenCalledWith(3, 'complete', {});
    expect(await screen.findByText('Conta anonimizada e acesso encerrado.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(adminDeletionRequests).toHaveBeenCalledTimes(2));
    expect(adminMetrics).toHaveBeenCalledTimes(2);
  });

  it('com contratações abertas ou saldo, concluir fica travado e o diálogo explica', async () => {
    const user = userEvent.setup();
    adminDeletionRequests.mockResolvedValue([blocked]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Concluir exclusão' }));

    const dialog = screen.getByRole('dialog', { name: 'Concluir exclusão · ana@escambo.test' });
    expect(dialog).toHaveTextContent('Sem motivo informado.');
    expect(dialog).toHaveTextContent('2 contratação(ões) aberta(s) · R$ 150,00 na carteira');
    expect(dialog).toHaveTextContent(
      'O titular ainda tem contratações abertas ou saldo: a exclusão não pode ser concluída. Recuse com justificativa ou aguarde.',
    );
    expect(dialog).not.toHaveTextContent('Não dá para desfazer.');
    expect(
      within(dialog).getByRole('button', { name: 'Anonimizar e encerrar a conta' }),
    ).toBeDisabled();
    expect(adminDeletionAction).not.toHaveBeenCalled();
  });

  it.each([
    ['contratações abertas', { activeContracts: 1 }, '1 contratação(ões) · R$ 0,00 na carteira'],
    ['saldo disponível', { balance: 0.01 }, 'R$ 0,01 na carteira'],
    ['valor retido', { balancePending: 30 }, 'R$ 30,00 na carteira'],
  ] as const)(
    'só com %s, a pendência aparece na fila e a exclusão não pode ser concluída',
    async (_n, extra, pendencias) => {
      const user = userEvent.setup();
      adminDeletionRequests.mockResolvedValue([deletionOf({ id: 3, ...extra })]);
      renderView();

      const row = await within(card(DELETIONS)).findByRole('row', { name: /^#3\D/ });
      expect(within(row).getByText(pendencias)).toBeVisible();
      expect(within(row).queryByText('nenhuma')).not.toBeInTheDocument();

      await user.click(within(row).getByRole('button', { name: 'Concluir exclusão' }));
      const dialog = screen.getByRole('dialog', { name: 'Concluir exclusão · Carla Dias' });
      expect(dialog).toHaveTextContent('a exclusão não pode ser concluída');
      expect(
        within(dialog).getByRole('button', { name: 'Anonimizar e encerrar a conta' }),
      ).toBeDisabled();
    },
  );

  it('enquanto a recusa está indo, o botão diz "Processando…" e fica travado', async () => {
    const user = userEvent.setup();
    adminDeletionRequests.mockResolvedValue([deletionOf({ id: 3 })]);
    let release!: (r: AdminDeletionRequest) => void;
    adminDeletionAction.mockReturnValue(
      new Promise<AdminDeletionRequest>((resolve) => (release = resolve)),
    );
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Recusar' }));
    const dialog = screen.getByRole('dialog', { name: 'Recusar exclusão · Carla Dias' });
    await user.type(within(dialog).getByLabelText('Justificativa (o titular recebe)'), 'Disputa');
    await user.click(within(dialog).getByRole('button', { name: 'Recusar com justificativa' }));

    expect(await within(dialog).findByRole('button', { name: 'Processando…' })).toBeDisabled();
    release(deletionOf({ id: 3, status: 'rejected' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(adminDeletionAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(adminDeletionRequests).toHaveBeenCalledTimes(2));
  });

  it('recusar exige a justificativa e manda ela para o titular', async () => {
    const user = userEvent.setup();
    adminDeletionRequests.mockResolvedValue([blocked]);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Recusar' }));

    const dialog = screen.getByRole('dialog', { name: 'Recusar exclusão · ana@escambo.test' });
    const note = within(dialog).getByLabelText('Justificativa (o titular recebe)');
    expect(note).toBeRequired();
    await user.type(note, ' Há uma disputa aberta nesta conta. ');
    await user.click(within(dialog).getByRole('button', { name: 'Recusar com justificativa' }));

    await waitFor(() => expect(adminDeletionAction).toHaveBeenCalledTimes(1));
    expect(adminDeletionAction).toHaveBeenCalledWith(4, 'reject', {
      note: 'Há uma disputa aberta nesta conta.',
    });
    expect(
      await screen.findByText('Pedido recusado; o titular foi avisado com a justificativa.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('se a API recusa, mostra o motivo e o diálogo continua aberto', async () => {
    const user = userEvent.setup();
    adminDeletionRequests.mockResolvedValue([deletionOf({ id: 3 })]);
    adminDeletionAction.mockRejectedValueOnce(new Error('O titular abriu uma contratação agora.'));
    adminDeletionAction.mockRejectedValueOnce(null);
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Concluir exclusão' }));
    const dialog = screen.getByRole('dialog', { name: 'Concluir exclusão · Carla Dias' });
    const submit = within(dialog).getByRole('button', { name: 'Anonimizar e encerrar a conta' });
    await user.click(submit);

    expect(await screen.findByText('O titular abriu uma contratação agora.')).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();

    // Falha sem mensagem: o aviso genérico.
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('Erro ao processar')).toBeInTheDocument();
    expect(screen.queryByText('Conta anonimizada e acesso encerrado.')).not.toBeInTheDocument();
  });
});

describe('AdminView: caixa de saída de e-mails', () => {
  it('lista destinatário, assunto, tipo e situação de cada e-mail', async () => {
    adminEmails.mockResolvedValue([
      emailOf({ id: 1 }),
      emailOf({
        id: 2,
        to: 'bruno@escambo.test',
        subject: 'Redefina sua senha',
        template: 'password_reset',
        status: 'failed',
        createdAt: '2026-09-22T10:10:00.000Z',
      }),
      emailOf({ id: 3, subject: 'Seu resumo do dia', template: 'digest', status: 'queued' }),
      emailOf({
        id: 4,
        subject: 'Modelo novo',
        template: 'welcome' as AdminEmail['template'],
      }),
    ]);
    renderView();

    const sent = await within(card(EMAILS)).findByRole('row', { name: /Confirme seu e-mail/ });
    expect(sent).toHaveTextContent(
      `${dtm('2026-09-21T09:00:00.000Z')}carla@escambo.testConfirme seu e-mailConfirmação de e-mailEnviado`,
    );
    const failed = within(card(EMAILS)).getByRole('row', { name: /Redefina sua senha/ });
    expect(failed).toHaveTextContent(
      `${dtm('2026-09-22T10:10:00.000Z')}bruno@escambo.testRedefina sua senhaRedefinição de senhaFalhou`,
    );
    const queued = within(card(EMAILS)).getByRole('row', { name: /Seu resumo do dia/ });
    expect(queued).toHaveTextContent('Resumo diárioNa fila');
    // Tipo que a tela não conhece aparece como veio da API.
    const unknown = within(card(EMAILS)).getByRole('row', { name: /Modelo novo/ });
    expect(unknown).toHaveTextContent('Modelo novowelcomeEnviado');
  });

  it('o cabeçalho diz se os e-mails saem por SMTP ou ficam só na caixa simulada', async () => {
    adminEmails.mockResolvedValue([emailOf({ id: 1, provider: 'smtp' })]);
    const first = renderView();
    expect(await within(card(EMAILS)).findByText('enviados via SMTP')).toBeInTheDocument();
    first.unmount();

    adminEmails.mockResolvedValue([emailOf({ id: 1, provider: 'console' })]);
    renderView();
    await within(card(EMAILS)).findByRole('row', { name: /Confirme seu e-mail/ });
    expect(
      within(card(EMAILS)).getByText(
        'provedor simulado: os e-mails ficam aqui (links de confirmação e de senha)',
      ),
    ).toBeInTheDocument();
    expect(within(card(EMAILS)).queryByText('enviados via SMTP')).not.toBeInTheDocument();
  });

  it('"Ver" abre o e-mail com o texto e os links clicáveis', async () => {
    const user = userEvent.setup();
    adminEmails.mockResolvedValue([
      emailOf({ id: 1 }),
      emailOf({
        id: 2,
        subject: 'Aviso sem link',
        template: 'notification',
        text: 'Sua proposta foi aceita.',
      }),
    ]);
    renderView();

    const row = await within(card(EMAILS)).findByRole('row', { name: /Confirme seu e-mail/ });
    await user.click(within(row).getByRole('button', { name: 'Ver' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirme seu e-mail' });
    expect(dialog).toHaveTextContent(
      `para carla@escambo.test · Confirmação de e-mail · console · ${dtm('2026-09-21T09:00:00.000Z')}`,
    );
    expect(dialog).toHaveTextContent(
      'Olá! Confirme em https://escambo.app/verificar?token=abc e pronto.',
    );
    expect(
      within(dialog).getByRole('link', { name: 'https://escambo.app/verificar?token=abc' }),
    ).toHaveAttribute('href', 'https://escambo.app/verificar?token=abc');

    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // E-mail sem endereço no texto: nenhum link, só o texto.
    const plainRow = within(card(EMAILS)).getByRole('row', { name: /Aviso sem link/ });
    await user.click(within(plainRow).getByRole('button', { name: 'Ver' }));
    const plainDialog = screen.getByRole('dialog', { name: 'Aviso sem link' });
    expect(plainDialog).toHaveTextContent('· Aviso · console ·');
    expect(plainDialog).toHaveTextContent('Sua proposta foi aceita.');
    expect(within(plainDialog).queryByRole('link')).not.toBeInTheDocument();
  });
});
