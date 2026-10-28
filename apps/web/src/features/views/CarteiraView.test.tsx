import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CreditTransaction,
  Deposit,
  Wallet,
  WalletTransaction,
  Withdrawal,
} from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { CarteiraView } from './CarteiraView';

/**
 * Carteira: saldos, extrato em reais e em créditos, saques (pedir e cancelar) e depósitos. O saque
 * é a única ação que tira dinheiro da plataforma: sem e-mail confirmado, o formulário dá lugar ao
 * reenvio do link.
 */

const wallet = vi.fn();
const publicSettings = vi.fn();
const withdrawals = vi.fn();
const deposits = vi.fn();
const walletTransactions = vi.fn();
const walletEarnings = vi.fn();
const creditTransactions = vi.fn();
const requestWithdrawal = vi.fn();
const cancelWithdrawal = vi.fn();
const resendVerification = vi.fn();
const deposit = vi.fn();
const cpfStatus = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    wallet: () => wallet(),
    publicSettings: () => publicSettings(),
    withdrawals: () => withdrawals(),
    deposits: () => deposits(),
    walletTransactions: (query: unknown) => walletTransactions(query),
    walletEarnings: (query: unknown) => walletEarnings(query),
    creditTransactions: (query: unknown) => creditTransactions(query),
    requestWithdrawal: (body: unknown) => requestWithdrawal(body),
    cancelWithdrawal: (id: number) => cancelWithdrawal(id),
    resendVerification: (...args: unknown[]) => resendVerification(...args),
    deposit: (id: number) => deposit(id),
    cpfStatus: () => cpfStatus(),
    createDeposit: vi.fn(),
    simulateDeposit: vi.fn(),
  },
}));

const auth = {
  user: { id: 1, email: 'bruno@escambo.test', emailVerified: true } as {
    id: number;
    email: string;
    emailVerified?: boolean;
    timezone?: string;
  } | null,
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

// O jsdom não desenha em canvas: o QR Code do depósito fica de fora (a tela não depende dele).
vi.mock('qrcode', () => ({ default: { toCanvas: () => Promise.resolve() } }));

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CarteiraView />
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

/** A seção (cartão) que tem o título dado: Extrato, Saques ou Depósitos. */
function card(title: string): HTMLElement {
  const section = screen.getByRole('heading', { level: 3, name: title }).closest('section');
  if (!section) throw new Error(`seção "${title}" não encontrada`);
  return section;
}

const page = <T,>(items: T[]) => ({ items, page: 1, limit: 20 });

const walletOf = (o: Partial<Wallet> = {}): Wallet => ({
  balance: 820.5,
  balancePending: 200,
  currency: 'BRL',
  credits: 45,
  creditsPending: 0,
  ...o,
});

const tx = (o: Partial<WalletTransaction> & { id: number }): WalletTransaction => ({
  amount: 100,
  pendingDelta: 0,
  balanceAfter: 100,
  pendingAfter: 0,
  reason: 'deposit',
  contractId: null,
  paymentId: null,
  withdrawalId: null,
  createdAt: '2026-09-20T15:30:00.000Z',
  ...o,
});

const creditTx = (o: Partial<CreditTransaction> & { id: number }): CreditTransaction => ({
  amount: 50,
  balanceAfter: 50,
  reason: 'welcome',
  contractId: null,
  createdAt: '2026-09-20T15:30:00.000Z',
  ...o,
});

const withdrawalOf = (o: Partial<Withdrawal> & { id: number }): Withdrawal => ({
  amount: 150,
  status: 'requested',
  method: 'pix',
  maskedDestination: 'b***@pix.com',
  createdAt: '2026-09-18T10:00:00.000Z',
  processedAt: null,
  dueAt: null,
  ...o,
});

const depositOf = (o: Partial<Deposit> & { id: number }): Deposit => ({
  amount: 100,
  status: 'paid',
  method: 'pix',
  gateway: 'simulated',
  reference: null,
  pixCode: null,
  expiresAt: null,
  paidAt: '2026-09-15T09:00:00.000Z',
  createdAt: '2026-09-15T08:00:00.000Z',
  canSimulate: false,
  ...o,
});

beforeEach(() => {
  auth.user = { id: 1, email: 'bruno@escambo.test', emailVerified: true };
  for (const fn of [
    wallet,
    publicSettings,
    withdrawals,
    deposits,
    walletTransactions,
    walletEarnings,
    creditTransactions,
    requestWithdrawal,
    cancelWithdrawal,
    resendVerification,
    deposit,
    cpfStatus,
  ]) {
    fn.mockReset();
  }
  wallet.mockResolvedValue(walletOf());
  // Freelancer com o CPF validado (RF-020): o saque segue como antes.
  cpfStatus.mockResolvedValue({
    available: true,
    required: true,
    hasFreelancerProfile: true,
    verified: true,
    maskedCpf: '***.982.247-**',
    birthDate: '1990-05-17',
    verifiedAt: '2026-10-20T12:00:00.000Z',
  });
  publicSettings.mockResolvedValue({ minWithdrawalAmount: 20 });
  withdrawals.mockResolvedValue(page([]));
  deposits.mockResolvedValue(page([]));
  walletTransactions.mockResolvedValue(page([]));
  // Ganhos (RF-082): quem nunca recebeu vê o vazio; a seção tem testes próprios.
  walletEarnings.mockResolvedValue({
    from: '2025-11-01',
    to: '2026-10-19',
    granularity: 'month',
    timezone: 'America/Sao_Paulo',
    hasEarnings: false,
    totals: { amount: 0, contracts: 0, barters: 0, averageTicket: null },
    series: [],
    credits: { total: 0, contracts: 0 },
  });
  creditTransactions.mockResolvedValue(page([]));
  requestWithdrawal.mockResolvedValue(withdrawalOf({ id: 99 }));
  cancelWithdrawal.mockResolvedValue(withdrawalOf({ id: 99, status: 'cancelled' }));
  resendVerification.mockResolvedValue(undefined);
});

describe('CarteiraView: saldos e estados', () => {
  it('enquanto nada chegou: saldos com travessão, quatro esqueletos e o mínimo padrão de R$ 20', () => {
    const never = new Promise(() => undefined);
    for (const fn of [
      wallet,
      publicSettings,
      withdrawals,
      deposits,
      walletTransactions,
      walletEarnings,
    ]) {
      fn.mockReturnValue(never);
    }
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: 'Carteira' })).toBeInTheDocument();
    expect(kpi('Saldo disponível')).toHaveTextContent('Saldo disponível—para contratar ou sacar');
    expect(kpi('Retido')).toHaveTextContent('Retido—reservado em propostas ou em escrow');
    expect(kpi('Créditos Escambo')).toHaveTextContent('Créditos Escambo—para contratar');
    // Ganhos, extrato, saques e depósitos.
    expect(screen.getAllByRole('status', { name: 'Carregando' })).toHaveLength(4);
    expect(screen.getByLabelText('Valor (R$) · mínimo R$ 20,00')).toHaveAttribute('min', '20');
    expect(document.title).toBe('Carteira · Escambo');
  });

  it('mostra o saldo disponível, o retido e os créditos', async () => {
    renderView();

    expect(await screen.findByText('R$ 820,50')).toBeInTheDocument();
    expect(kpi('Saldo disponível')).toHaveTextContent('R$ 820,50');
    expect(kpi('Retido')).toHaveTextContent('R$ 200,00');
    expect(kpi('Créditos Escambo')).toHaveTextContent('45para contratar ou impulsionar');
  });

  it('créditos em escrow aparecem na dica dos créditos', async () => {
    wallet.mockResolvedValue(walletOf({ credits: 45, creditsPending: 12 }));
    renderView();

    await screen.findByText('R$ 820,50');
    expect(kpi('Créditos Escambo')).toHaveTextContent(
      '4512 em escrow · para contratar ou impulsionar',
    );
  });

  it('sem movimentação nenhuma, cada lista diz que está vazia', async () => {
    const user = userEvent.setup();
    renderView();

    expect(
      await screen.findByText(
        'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('Nenhum saque ainda.')).toBeInTheDocument();
    expect(await screen.findByText('Nenhum depósito ainda.')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Créditos' }));
    expect(await screen.findByText('Nenhuma movimentação de créditos ainda.')).toBeInTheDocument();
  });

  it('falha no extrato: mostra o erro só ali e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    walletTransactions.mockRejectedValueOnce(new Error('Extrato indisponível.'));
    walletTransactions.mockResolvedValue(page([tx({ id: 1 })]));
    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Extrato indisponível.');
    expect(card('Extrato')).toContainElement(alert);
    expect(await screen.findByText('Nenhum saque ainda.')).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(card('Extrato')).findByText('Depósito via PIX')).toBeInTheDocument();
    expect(walletTransactions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Saques', withdrawals, 'Saques indisponíveis.', 'Nenhum saque ainda.'],
    ['Depósitos', deposits, 'Depósitos indisponíveis.', 'Nenhum depósito ainda.'],
  ] as const)(
    'falha em %s: o erro aparece só naquele cartão e "Tentar de novo" refaz só aquela busca',
    async (title, fn, msg, empty) => {
      const user = userEvent.setup();
      fn.mockRejectedValueOnce(new Error(msg));
      fn.mockResolvedValue(page([]));
      renderView();

      const alert = await within(card(title)).findByRole('alert');
      expect(alert).toHaveTextContent(msg);
      expect(
        await screen.findByText(
          'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.',
        ),
      ).toBeInTheDocument();
      expect(screen.getAllByRole('alert')).toHaveLength(1);

      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await within(card(title)).findByText(empty)).toBeInTheDocument();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(walletTransactions).toHaveBeenCalledTimes(1);
    },
  );

  it('falha no extrato de créditos: o erro aparece na aba e "Tentar de novo" busca os créditos', async () => {
    const user = userEvent.setup();
    creditTransactions.mockRejectedValueOnce(new Error('Créditos indisponíveis.'));
    creditTransactions.mockResolvedValue(page([creditTx({ id: 1 })]));
    renderView();

    await user.click(screen.getByRole('tab', { name: 'Créditos' }));
    const alert = await within(card('Extrato')).findByRole('alert');
    expect(alert).toHaveTextContent('Créditos indisponíveis.');

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(card('Extrato')).findByText('Bônus de boas-vindas')).toBeInTheDocument();
    expect(creditTransactions).toHaveBeenCalledTimes(2);
    expect(walletTransactions).toHaveBeenCalledTimes(1);
  });
});

describe('CarteiraView: extrato', () => {
  it('em reais: motivo, a que se refere, o saldo depois e o valor com sinal', async () => {
    walletTransactions.mockResolvedValue(
      page([
        tx({ id: 1, reason: 'deposit', amount: 100, balanceAfter: 100, paymentId: 2 }),
        tx({
          id: 2,
          reason: 'withdrawal',
          amount: -50,
          balanceAfter: 50,
          withdrawalId: 4,
          createdAt: '2026-09-21T18:45:00.000Z',
        }),
        tx({ id: 3, reason: 'payment', amount: -30, balanceAfter: 20, contractId: 9 }),
      ]),
    );
    renderView();

    await within(card('Extrato')).findByText('Depósito via PIX');
    const rows = within(card('Extrato')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveTextContent('Depósito via PIX');
    expect(rows[0]).toHaveTextContent(
      `${dtm('2026-09-20T15:30:00.000Z')} · depósito #2 · disponível R$ 100,00`,
    );
    expect(rows[0]).toHaveTextContent(/\+R\$ 100,00$/);
    expect(rows[0]).not.toHaveTextContent('retido');

    expect(rows[1]).toHaveTextContent('Saque solicitado');
    expect(rows[1]).toHaveTextContent(
      `${dtm('2026-09-21T18:45:00.000Z')} · saque #4 · disponível R$ 50,00`,
    );
    expect(rows[1]).toHaveTextContent(/−R\$ 50,00$/);

    expect(rows[2]).toHaveTextContent('Pagamento da contratação');
    expect(rows[2]).toHaveTextContent('· contrato #9 · disponível R$ 20,00');
    expect(rows[2]).toHaveTextContent(/−R\$ 30,00$/);
  });

  it('quando só o retido muda, a linha mostra o valor retido com a marca de "retido"', async () => {
    walletTransactions.mockResolvedValue(
      page([
        tx({
          id: 1,
          reason: 'escrow_in',
          amount: 0,
          pendingDelta: 170,
          balanceAfter: 40,
          pendingAfter: 170,
          contractId: 9,
        }),
        tx({
          id: 2,
          reason: 'escrow_refund',
          amount: 0,
          pendingDelta: -170,
          balanceAfter: 40,
          pendingAfter: 0,
          contractId: 9,
        }),
        tx({ id: 3, reason: 'deposit', amount: 40, balanceAfter: 40 }),
      ]),
    );
    renderView();

    await within(card('Extrato')).findByText('Recebido em escrow');
    const rows = within(card('Extrato')).getAllByRole('listitem');

    expect(rows[0]).toHaveTextContent('· contrato #9 · disponível R$ 40,00 · retido R$ 170,00');
    expect(rows[0]).toHaveTextContent(/\+R\$ 170,00$/);
    expect(within(rows[0]!).getByLabelText('retido')).toBeInTheDocument();

    expect(rows[1]).toHaveTextContent('Escrow devolvido ao cliente');
    expect(rows[1]).toHaveTextContent(/−R\$ 170,00$/);
    expect(within(rows[1]!).getByLabelText('retido')).toBeInTheDocument();
    // Retido zerado depois do movimento: a linha de apoio não repete "retido R$ 0,00".
    expect(rows[1]).not.toHaveTextContent('retido R$');

    // Movimento do disponível, sem referência: nem marca de retido, nem "contrato/saque/depósito".
    expect(within(rows[2]!).queryByLabelText('retido')).not.toBeInTheDocument();
    expect(rows[2]).toHaveTextContent(`${dtm('2026-09-20T15:30:00.000Z')} · disponível R$ 40,00`);
  });

  it('em créditos: a aba troca a lista, com motivo, contrato, saldo depois e o valor com sinal', async () => {
    const user = userEvent.setup();
    walletTransactions.mockResolvedValue(page([tx({ id: 1 })]));
    creditTransactions.mockResolvedValue(
      page([
        creditTx({ id: 1, reason: 'welcome', amount: 50, balanceAfter: 50 }),
        creditTx({ id: 2, reason: 'escrow_hold', amount: -20, balanceAfter: 30, contractId: 5 }),
        creditTx({ id: 3, reason: 'boost', amount: -10, balanceAfter: 20 }),
      ]),
    );
    renderView();

    const tabs = screen.getByRole('tablist', { name: 'Moeda do extrato' });
    expect(within(tabs).getByRole('tab', { name: 'Reais' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await within(card('Extrato')).findByText('Depósito via PIX');

    await user.click(within(tabs).getByRole('tab', { name: 'Créditos' }));

    expect(within(tabs).getByRole('tab', { name: 'Créditos' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'Reais' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(within(card('Extrato')).queryByText('Depósito via PIX')).not.toBeInTheDocument();
    const rows = within(card('Extrato')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Bônus de boas-vindas');
    expect(rows[0]).toHaveTextContent(`${dtm('2026-09-20T15:30:00.000Z')} · saldo após: 50`);
    expect(rows[0]).toHaveTextContent(/\+50$/);
    expect(rows[1]).toHaveTextContent('Retido para contratação');
    expect(rows[1]).toHaveTextContent('· contrato #5 · saldo após: 30');
    expect(rows[1]).toHaveTextContent(/-20$/);
    expect(rows[2]).toHaveTextContent('Impulsionamento');
    expect(rows[2]).toHaveTextContent(/-10$/);

    await user.click(within(tabs).getByRole('tab', { name: 'Reais' }));
    expect(within(card('Extrato')).getByText('Depósito via PIX')).toBeInTheDocument();
  });
});

describe('CarteiraView: extrato por período e "Carregar mais" (RF-047)', () => {
  const ledgerPage = (items: WalletTransaction[], number: number, hasMore: boolean) => ({
    items,
    page: number,
    limit: 20,
    hasMore,
  });

  it('pede 20 por vez; com mais lançamentos, "Carregar mais" junta a próxima página abaixo', async () => {
    const user = userEvent.setup();
    walletTransactions
      .mockResolvedValueOnce(
        ledgerPage([tx({ id: 3 }), tx({ id: 2, reason: 'withdrawal', amount: -50 })], 1, true),
      )
      // Um lançamento novo empurrou o 2 para a página seguinte: ele não aparece duas vezes.
      .mockResolvedValueOnce(
        ledgerPage(
          [
            tx({ id: 2, reason: 'withdrawal', amount: -50 }),
            tx({ id: 1, reason: 'payment', amount: -30 }),
          ],
          2,
          false,
        ),
      );
    renderView();

    const more = await within(card('Extrato')).findByRole('button', { name: 'Carregar mais' });
    expect(walletTransactions).toHaveBeenCalledWith({ page: 1, limit: 20 });
    expect(within(card('Extrato')).getAllByRole('listitem')).toHaveLength(2);

    await user.click(more);

    await waitFor(() => expect(within(card('Extrato')).getAllByRole('listitem')).toHaveLength(3));
    expect(walletTransactions).toHaveBeenLastCalledWith({ page: 2, limit: 20 });
    const rows = within(card('Extrato')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Depósito via PIX');
    expect(rows[1]).toHaveTextContent('Saque solicitado');
    expect(rows[2]).toHaveTextContent('Pagamento da contratação');
    // Última página: o botão some.
    expect(
      within(card('Extrato')).queryByRole('button', { name: 'Carregar mais' }),
    ).not.toBeInTheDocument();
  });

  it('enquanto a próxima página chega, o botão fica travado em "Carregando…"', async () => {
    const user = userEvent.setup();
    let release!: (p: ReturnType<typeof ledgerPage>) => void;
    walletTransactions
      .mockResolvedValueOnce(ledgerPage([tx({ id: 3 })], 1, true))
      .mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    renderView();

    await user.click(await within(card('Extrato')).findByRole('button', { name: 'Carregar mais' }));

    const busy = await within(card('Extrato')).findByRole('button', { name: 'Carregando…' });
    expect(busy).toBeDisabled();
    release(ledgerPage([tx({ id: 1 })], 2, false));
    await waitFor(() => expect(within(card('Extrato')).getAllByRole('listitem')).toHaveLength(2));
  });

  it('sem "hasMore", não há "Carregar mais"', async () => {
    walletTransactions.mockResolvedValue(ledgerPage([tx({ id: 1 })], 1, false));
    renderView();

    await within(card('Extrato')).findByText('Depósito via PIX');
    expect(
      within(card('Extrato')).queryByRole('button', { name: 'Carregar mais' }),
    ).not.toBeInTheDocument();
  });

  it('de/até vão para a API; período sem nada tem o próprio aviso; "Limpar período" volta ao extrato inteiro', async () => {
    const user = userEvent.setup();
    renderView();
    await within(card('Extrato')).findByText(
      'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.',
    );

    const period = within(card('Extrato')).getByRole('group', { name: 'Período do extrato' });
    const from = within(period).getByLabelText('De');
    const to = within(period).getByLabelText('Até');
    expect(from).toHaveAttribute('type', 'date');
    expect(within(card('Extrato')).getByText('Dias no horário de Brasília.')).toBeInTheDocument();
    expect(
      within(period).queryByRole('button', { name: 'Limpar período' }),
    ).not.toBeInTheDocument();

    fireEvent.change(from, { target: { value: '2026-10-01' } });
    await waitFor(() =>
      expect(walletTransactions).toHaveBeenLastCalledWith({
        from: '2026-10-01',
        page: 1,
        limit: 20,
      }),
    );
    // Uma data não passa da outra: o calendário trava no limite.
    expect(to).toHaveAttribute('min', '2026-10-01');

    fireEvent.change(to, { target: { value: '2026-10-15' } });
    await waitFor(() =>
      expect(walletTransactions).toHaveBeenLastCalledWith({
        from: '2026-10-01',
        to: '2026-10-15',
        page: 1,
        limit: 20,
      }),
    );
    expect(from).toHaveAttribute('max', '2026-10-15');
    expect(
      await within(card('Extrato')).findByText('Nenhuma movimentação em reais nesse período.'),
    ).toBeInTheDocument();

    const callsBefore = walletTransactions.mock.calls.length;
    await user.click(within(period).getByRole('button', { name: 'Limpar período' }));

    expect(from).toHaveValue('');
    expect(to).toHaveValue('');
    expect(
      await within(card('Extrato')).findByText(
        'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(walletTransactions.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(walletTransactions).toHaveBeenLastCalledWith({ page: 1, limit: 20 });
  });

  it('período invertido: avisa ali mesmo e não pede nada à API', async () => {
    renderView();
    await within(card('Extrato')).findByText(
      'Nenhuma movimentação em reais ainda. Faça um depósito para contratar.',
    );
    const period = within(card('Extrato')).getByRole('group', { name: 'Período do extrato' });

    fireEvent.change(within(period).getByLabelText('Até'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(period).getByLabelText('De'), { target: { value: '2026-10-15' } });

    expect(await within(card('Extrato')).findByRole('alert')).toHaveTextContent(
      'A data inicial precisa ser até a final.',
    );
    expect(within(card('Extrato')).queryByTestId('ledger')).not.toBeInTheDocument();
    expect(
      walletTransactions.mock.calls.some(([q]) => (q as { from?: string }).from === '2026-10-15'),
    ).toBe(false);
  });

  it('os dias são os do fuso da conta, e o mesmo período vale para a aba de créditos', async () => {
    const user = userEvent.setup();
    auth.user = {
      id: 1,
      email: 'bruno@escambo.test',
      emailVerified: true,
      timezone: 'America/Manaus',
    };
    renderView();

    expect(
      await within(card('Extrato')).findByText('Dias no horário de Manaus.'),
    ).toBeInTheDocument();
    const period = within(card('Extrato')).getByRole('group', { name: 'Período do extrato' });
    fireEvent.change(within(period).getByLabelText('De'), { target: { value: '2026-10-01' } });

    await user.click(screen.getByRole('tab', { name: 'Créditos' }));
    const same = within(card('Extrato')).getByRole('group', { name: 'Período do extrato' });
    expect(within(same).getByLabelText('De')).toHaveValue('2026-10-01');
    expect(within(card('Extrato')).getByText('Dias no horário de Manaus.')).toBeInTheDocument();
    await waitFor(() =>
      expect(creditTransactions).toHaveBeenLastCalledWith({
        from: '2026-10-01',
        page: 1,
        limit: 20,
      }),
    );
  });
});

describe('CarteiraView: extrato de créditos por período e "Carregar mais" (RF-047)', () => {
  const creditPage = (items: CreditTransaction[], number: number, hasMore: boolean) => ({
    items,
    page: number,
    limit: 20,
    hasMore,
  });

  it('pede 20 por vez; "Carregar mais" junta a próxima página sem repetir lançamento', async () => {
    const user = userEvent.setup();
    creditTransactions
      .mockResolvedValueOnce(creditPage([creditTx({ id: 3 }), creditTx({ id: 2 })], 1, true))
      .mockResolvedValueOnce(
        creditPage(
          [creditTx({ id: 2 }), creditTx({ id: 1, reason: 'boost', amount: -10 })],
          2,
          false,
        ),
      );
    renderView();

    await user.click(screen.getByRole('tab', { name: 'Créditos' }));
    const more = await within(card('Extrato')).findByRole('button', { name: 'Carregar mais' });
    expect(creditTransactions).toHaveBeenCalledWith({ page: 1, limit: 20 });
    expect(within(card('Extrato')).getAllByRole('listitem')).toHaveLength(2);

    await user.click(more);

    await waitFor(() => expect(within(card('Extrato')).getAllByRole('listitem')).toHaveLength(3));
    expect(creditTransactions).toHaveBeenLastCalledWith({ page: 2, limit: 20 });
    expect(within(card('Extrato')).getAllByRole('listitem')[2]).toHaveTextContent(
      'Impulsionamento',
    );
    expect(
      within(card('Extrato')).queryByRole('button', { name: 'Carregar mais' }),
    ).not.toBeInTheDocument();
  });

  it('de/até vão para a API de créditos; período sem nada tem o próprio aviso; "Limpar período" volta', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('tab', { name: 'Créditos' }));
    expect(
      await within(card('Extrato')).findByText('Nenhuma movimentação de créditos ainda.'),
    ).toBeInTheDocument();

    const period = within(card('Extrato')).getByRole('group', { name: 'Período do extrato' });
    fireEvent.change(within(period).getByLabelText('De'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(period).getByLabelText('Até'), { target: { value: '2026-10-15' } });

    await waitFor(() =>
      expect(creditTransactions).toHaveBeenLastCalledWith({
        from: '2026-10-01',
        to: '2026-10-15',
        page: 1,
        limit: 20,
      }),
    );
    expect(
      await within(card('Extrato')).findByText('Nenhuma movimentação de créditos nesse período.'),
    ).toBeInTheDocument();

    await user.click(within(period).getByRole('button', { name: 'Limpar período' }));
    expect(
      await within(card('Extrato')).findByText('Nenhuma movimentação de créditos ainda.'),
    ).toBeInTheDocument();
    expect(creditTransactions).toHaveBeenLastCalledWith({ page: 1, limit: 20 });
  });

  it('período invertido: avisa na aba de créditos e não pede nada à API', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('tab', { name: 'Créditos' }));
    const period = within(card('Extrato')).getByRole('group', { name: 'Período do extrato' });

    fireEvent.change(within(period).getByLabelText('Até'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(period).getByLabelText('De'), { target: { value: '2026-10-15' } });

    expect(await within(card('Extrato')).findByRole('alert')).toHaveTextContent(
      'A data inicial precisa ser até a final.',
    );
    expect(within(card('Extrato')).queryByTestId('credit-ledger')).not.toBeInTheDocument();
    expect(
      creditTransactions.mock.calls.some(([q]) => (q as { from?: string }).from === '2026-10-15'),
    ).toBe(false);
  });
});

describe('CarteiraView: prazo do saque (RN-035)', () => {
  // Segunda, 19/10/2026, 10:00 em Brasília. Só o Date é falso: os timers seguem reais.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T13:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('ao escolher PIX ou transferência, o formulário diz em quantos dias úteis e o dia em que cai', async () => {
    const user = userEvent.setup();
    publicSettings.mockResolvedValue({
      minWithdrawalAmount: 20,
      withdrawalBusinessDays: { pix: 1, bank: 3 },
    });
    renderView();

    const due = screen.getByTestId('withdraw-due');
    // Antes dos parâmetros chegarem, os padrões da RN-035 (PIX: 1 dia útil).
    expect(due).toHaveTextContent('Em até 1 dia útil (seg. a sex.): cai até ter, 20/10.');

    await user.selectOptions(screen.getByLabelText('Receber por'), 'bank');
    // O parâmetro do admin vale: 3 dias úteis a partir de segunda = quinta.
    await waitFor(() =>
      expect(screen.getByTestId('withdraw-due')).toHaveTextContent(
        'Em até 3 dias úteis (seg. a sex.): cai até qui, 22/10.',
      ),
    );

    await user.selectOptions(screen.getByLabelText('Receber por'), 'pix');
    expect(screen.getByTestId('withdraw-due')).toHaveTextContent('cai até ter, 20/10.');
  });

  it('sexta à noite: o prazo pula o fim de semana', async () => {
    vi.setSystemTime(new Date('2026-10-24T01:30:00.000Z')); // sex, 23/10, 22:30 em Brasília
    publicSettings.mockResolvedValue({ minWithdrawalAmount: 20 });
    renderView();

    expect(screen.getByTestId('withdraw-due')).toHaveTextContent('cai até seg, 26/10.');
  });

  it('pedido feito: o aviso diz o dia que a API gravou', async () => {
    const user = userEvent.setup();
    requestWithdrawal.mockResolvedValue(
      withdrawalOf({ id: 99, dueAt: '2026-10-21T02:59:59.000Z' }),
    );
    renderView();
    await screen.findByText('R$ 820,50');

    await user.type(screen.getByLabelText(/^Valor \(R\$\)/), '50');
    await user.type(screen.getByLabelText('Chave PIX'), 'bruno@pix.com');
    await user.click(screen.getByRole('button', { name: /^Sacar/ }));

    expect(
      await screen.findByText(
        'Saque solicitado! Cai até ter, 20/10. Você recebe um aviso quando for pago.',
      ),
    ).toBeInTheDocument();
  });

  it('a lista diz até quando cai cada saque aberto, avisa o que passou do prazo e cala nos encerrados', async () => {
    withdrawals.mockResolvedValue(
      page([
        withdrawalOf({ id: 4, status: 'requested', dueAt: '2026-10-21T02:59:59.000Z' }),
        withdrawalOf({ id: 3, status: 'processing', dueAt: '2026-10-17T02:59:59.000Z' }),
        withdrawalOf({
          id: 2,
          status: 'completed',
          dueAt: '2026-10-16T02:59:59.000Z',
          processedAt: '2026-10-15T12:00:00.000Z',
        }),
        withdrawalOf({ id: 1, status: 'requested', dueAt: null }),
      ]),
    );
    renderView();

    await within(card('Saques')).findAllByText('R$ 150,00');
    const rows = within(card('Saques')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(
      `PIX · b***@pix.com · ${dtm('2026-09-18T10:00:00.000Z')} · cai até ter, 20/10`,
    );
    expect(rows[1]).toHaveTextContent('· prazo era sex, 16/10');
    expect(rows[1]).not.toHaveTextContent('cai até');
    expect(rows[2]).not.toHaveTextContent('cai até');
    expect(rows[2]).not.toHaveTextContent('prazo era');
    expect(rows[3]).not.toHaveTextContent('cai até');
  });
});

describe('CarteiraView: pedir saque', () => {
  it('o mínimo do saque vem das configurações da plataforma', async () => {
    publicSettings.mockResolvedValue({ minWithdrawalAmount: 35 });
    renderView();

    expect(await screen.findByLabelText('Valor (R$) · mínimo R$ 35,00')).toHaveAttribute(
      'min',
      '35',
    );
    // O botão diz o mesmo mínimo (antes, "R$20" fixo).
    expect(
      screen.getByRole('button', { name: /^Sacar \(mín\. R\$\s35,00\)$/ }),
    ).toBeInTheDocument();
  });

  it('envia valor e chave PIX, avisa, limpa o formulário e recarrega a carteira', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText('R$ 820,50');

    const amount = screen.getByLabelText(/^Valor \(R\$\)/);
    const pixKey = screen.getByLabelText('Chave PIX');
    await user.type(amount, '150.5');
    await user.type(pixKey, 'bruno@pix.com');
    await user.click(screen.getByRole('button', { name: /^Sacar/ }));

    await waitFor(() => expect(requestWithdrawal).toHaveBeenCalledTimes(1));
    expect(requestWithdrawal).toHaveBeenCalledWith({
      amount: 150.5,
      method: 'pix',
      pixKey: 'bruno@pix.com',
    });
    expect(
      await screen.findByText('Saque solicitado! Você recebe um aviso quando for pago.'),
    ).toBeInTheDocument();
    expect(amount).toHaveValue(null);
    expect(pixKey).toHaveValue('');
    // Saldo, extrato, depósitos e saques são buscados de novo.
    await waitFor(() => expect(withdrawals).toHaveBeenCalledTimes(2));
    expect(wallet).toHaveBeenCalledTimes(2);
    expect(walletTransactions).toHaveBeenCalledTimes(2);
    expect(deposits).toHaveBeenCalledTimes(2);
  });

  it('o PIX vem escolhido; por transferência, a chave dá lugar a banco, agência e conta (RF-045)', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText('R$ 820,50');

    const method = screen.getByLabelText('Receber por');
    expect(method).toHaveValue('pix');
    expect(
      within(method)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['PIX', 'Transferência bancária']);
    expect(screen.queryByLabelText('Banco')).not.toBeInTheDocument();

    await user.selectOptions(method, 'bank');

    expect(screen.queryByLabelText('Chave PIX')).not.toBeInTheDocument();
    const bank = screen.getByLabelText('Banco');
    const agency = screen.getByLabelText('Agência');
    const account = screen.getByLabelText('Conta');
    // Os mesmos tetos da API (withdrawal.schema): o campo não deixa passar do tamanho.
    for (const [field, max] of [
      [bank, '100'],
      [agency, '10'],
      [account, '20'],
    ] as const) {
      expect(field).toBeRequired();
      expect(field).toHaveAttribute('maxLength', max);
    }
  });

  it('por transferência: envia banco, agência e conta (sem chave PIX), avisa e limpa o formulário', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText('R$ 820,50');

    await user.selectOptions(screen.getByLabelText('Receber por'), 'bank');
    await user.type(screen.getByLabelText(/^Valor \(R\$\)/), '80');
    await user.type(screen.getByLabelText('Banco'), 'Banco do Brasil');
    await user.type(screen.getByLabelText('Agência'), '1234');
    await user.type(screen.getByLabelText('Conta'), '56789-0');
    await user.click(screen.getByRole('button', { name: /^Sacar/ }));

    await waitFor(() => expect(requestWithdrawal).toHaveBeenCalledTimes(1));
    expect(requestWithdrawal).toHaveBeenCalledWith({
      amount: 80,
      method: 'bank',
      bankName: 'Banco do Brasil',
      bankAgency: '1234',
      bankAccount: '56789-0',
    });
    expect(
      await screen.findByText('Saque solicitado! Você recebe um aviso quando for pago.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Banco')).toHaveValue('');
    expect(screen.getByLabelText('Agência')).toHaveValue('');
    expect(screen.getByLabelText('Conta')).toHaveValue('');
    // A forma escolhida fica para o próximo saque.
    expect(screen.getByLabelText('Receber por')).toHaveValue('bank');
  });

  it('voltar para PIX: só a chave vai, e os dados bancários digitados ficam de fora', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText('R$ 820,50');

    await user.selectOptions(screen.getByLabelText('Receber por'), 'bank');
    await user.type(screen.getByLabelText('Banco'), 'Banco do Brasil');
    await user.selectOptions(screen.getByLabelText('Receber por'), 'pix');
    await user.type(screen.getByLabelText(/^Valor \(R\$\)/), '50');
    await user.type(screen.getByLabelText('Chave PIX'), 'bruno@pix.com');
    await user.click(screen.getByRole('button', { name: /^Sacar/ }));

    await waitFor(() => expect(requestWithdrawal).toHaveBeenCalledTimes(1));
    expect(requestWithdrawal).toHaveBeenCalledWith({
      amount: 50,
      method: 'pix',
      pixKey: 'bruno@pix.com',
    });
  });

  it('enquanto o pedido está indo, o botão fica desabilitado', async () => {
    const user = userEvent.setup();
    let release!: (w: Withdrawal) => void;
    requestWithdrawal.mockReturnValue(new Promise<Withdrawal>((resolve) => (release = resolve)));
    renderView();
    await screen.findByText('R$ 820,50');

    await user.type(screen.getByLabelText(/^Valor \(R\$\)/), '50');
    await user.type(screen.getByLabelText('Chave PIX'), '47999990000');
    const submit = screen.getByRole('button', { name: /^Sacar/ });
    await user.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent('…');
    release(withdrawalOf({ id: 99 }));
    await waitFor(() => expect(submit).toBeEnabled());
    expect(submit).toHaveTextContent(/^Sacar/);
  });

  it('se a API recusa, mostra o motivo e mantém o que foi digitado', async () => {
    const user = userEvent.setup();
    requestWithdrawal.mockRejectedValue(new Error('Saldo insuficiente para o saque.'));
    renderView();
    await screen.findByText('R$ 820,50');

    const amount = screen.getByLabelText(/^Valor \(R\$\)/);
    const pixKey = screen.getByLabelText('Chave PIX');
    await user.type(amount, '5000');
    await user.type(pixKey, 'bruno@pix.com');
    await user.click(screen.getByRole('button', { name: /^Sacar/ }));

    expect(await screen.findByText('Saldo insuficiente para o saque.')).toBeInTheDocument();
    expect(amount).toHaveValue(5000);
    expect(pixKey).toHaveValue('bruno@pix.com');
    expect(
      screen.queryByText('Saque solicitado! Você recebe um aviso quando for pago.'),
    ).not.toBeInTheDocument();
  });

  it('falha sem mensagem vira o aviso genérico de erro no saque', async () => {
    const user = userEvent.setup();
    requestWithdrawal.mockRejectedValue('timeout');
    renderView();
    await screen.findByText('R$ 820,50');

    await user.type(screen.getByLabelText(/^Valor \(R\$\)/), '50');
    await user.type(screen.getByLabelText('Chave PIX'), 'bruno@pix.com');
    await user.click(screen.getByRole('button', { name: /^Sacar/ }));

    expect(await screen.findByText('Erro no saque')).toBeInTheDocument();
  });
});

describe('CarteiraView: e-mail sem confirmação conhecida', () => {
  it('sem a informação de e-mail confirmado na sessão, o formulário de saque aparece (a API é quem barra)', async () => {
    auth.user = { id: 1, email: 'bruno@escambo.test' };
    renderView();

    expect(await screen.findByLabelText('Chave PIX')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sacar/ })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Reenviar e-mail de confirmação' }),
    ).not.toBeInTheDocument();
  });
});

/** RF-020: quem entrega trabalho saca com o CPF validado; a Carteira diz o motivo e leva ao Perfil. */
describe('CarteiraView: CPF para sacar', () => {
  const renderRouted = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <CarteiraView />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  };
  const status = (o: Record<string, unknown>) => ({
    available: true,
    required: true,
    hasFreelancerProfile: true,
    verified: false,
    maskedCpf: null,
    birthDate: null,
    verifiedAt: null,
    ...o,
  });

  it('sem o CPF validado: no lugar do formulário, o motivo e o caminho para "Dados para receber"', async () => {
    cpfStatus.mockResolvedValue(status({}));
    renderRouted();

    const locked = await screen.findByTestId('withdraw-cpf');
    expect(locked).toHaveTextContent('Valide seu CPF para sacar');
    expect(within(locked).getByRole('link', { name: 'Informar o CPF' })).toHaveAttribute(
      'href',
      '/perfil#dados-recebimento',
    );
    expect(screen.queryByRole('button', { name: /^Sacar/ })).not.toBeInTheDocument();
  });

  it('servidor sem a chave de cifragem: diz que a validação não está disponível e leva ao suporte', async () => {
    cpfStatus.mockResolvedValue(status({ available: false }));
    renderRouted();

    const locked = await screen.findByTestId('withdraw-cpf');
    expect(locked).toHaveTextContent('a validação de CPF ainda não está disponível neste servidor');
    expect(within(locked).getByRole('link', { name: 'Falar com o suporte' })).toHaveAttribute(
      'href',
      '/suporte',
    );
  });

  it('quem só contrata (não entrega trabalho) saca sem CPF', async () => {
    cpfStatus.mockResolvedValue(status({ required: false, hasFreelancerProfile: false }));
    renderRouted();

    expect(await screen.findByRole('button', { name: /^Sacar/ })).toBeInTheDocument();
    expect(screen.queryByTestId('withdraw-cpf')).not.toBeInTheDocument();
  });

  it('sem e-mail confirmado, o aviso do e-mail vem primeiro', async () => {
    auth.user = { id: 1, email: 'bruno@escambo.test', emailVerified: false };
    cpfStatus.mockResolvedValue(status({}));
    renderRouted();

    expect(await screen.findByTestId('withdraw-locked')).toBeInTheDocument();
    await waitFor(() => expect(cpfStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('withdraw-cpf')).not.toBeInTheDocument();
  });
});

describe('CarteiraView: e-mail não confirmado', () => {
  beforeEach(() => {
    auth.user = { id: 1, email: 'bruno@escambo.test', emailVerified: false };
  });

  it('no lugar do formulário de saque, explica e oferece reenviar o link', async () => {
    renderView();
    await screen.findByText('R$ 820,50');

    expect(screen.queryByRole('button', { name: /^Sacar/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Chave PIX')).not.toBeInTheDocument();
    expect(kpi('Solicitar saque')).toHaveTextContent(
      'Confirme seu e-mail para sacar. Enviamos um link para bruno@escambo.test.',
    );
    expect(kpi('Solicitar saque')).toHaveTextContent(
      'Segurança: o saque é a única ação que tira dinheiro da plataforma.',
    );
    expect(screen.getByRole('button', { name: 'Reenviar e-mail de confirmação' })).toBeEnabled();
  });

  it('reenviar chama a API, trava o botão enquanto vai e avisa para qual e-mail foi', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    resendVerification.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    renderView();

    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail de confirmação' }));

    const busy = await screen.findByRole('button', { name: 'Reenviando…' });
    expect(busy).toBeDisabled();
    expect(resendVerification).toHaveBeenCalledTimes(1);
    expect(resendVerification).toHaveBeenCalledWith();

    release();
    expect(await screen.findByText('Link reenviado para bruno@escambo.test.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar e-mail de confirmação' })).toBeEnabled();
  });

  it('se o reenvio falha, mostra o motivo e o botão volta a funcionar', async () => {
    const user = userEvent.setup();
    resendVerification.mockRejectedValueOnce(new Error('Aguarde 1 minuto para reenviar.'));
    resendVerification.mockRejectedValueOnce('offline');
    renderView();

    const button = screen.getByRole('button', { name: 'Reenviar e-mail de confirmação' });
    await user.click(button);
    expect(await screen.findByText('Aguarde 1 minuto para reenviar.')).toBeInTheDocument();

    // Falha sem mensagem: o aviso genérico.
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail de confirmação' }));
    expect(await screen.findByText('Não foi possível reenviar')).toBeInTheDocument();
    expect(resendVerification).toHaveBeenCalledTimes(2);
  });
});

describe('CarteiraView: saques e depósitos', () => {
  it('lista os saques com destino, data e situação; só o que está aguardando pode ser cancelado', async () => {
    withdrawals.mockResolvedValue(
      page([
        withdrawalOf({ id: 4, amount: 150, status: 'requested' }),
        withdrawalOf({
          id: 3,
          amount: 80,
          status: 'completed',
          method: 'bank',
          maskedDestination: 'Ag 0001 · ***42',
          processedAt: '2026-09-19T14:20:00.000Z',
        }),
        withdrawalOf({ id: 2, amount: 60, status: 'processing' }),
        withdrawalOf({ id: 1, amount: 40, status: 'failed' }),
      ]),
    );
    renderView();

    await within(card('Saques')).findByText('R$ 150,00');
    const rows = within(card('Saques')).getAllByRole('listitem');
    expect(rows).toHaveLength(4);

    expect(rows[0]).toHaveTextContent(`PIX · b***@pix.com · ${dtm('2026-09-18T10:00:00.000Z')}`);
    expect(within(rows[0]!).getByText('Aguardando')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Cancelar' })).toBeEnabled();

    // Saque processado mostra a data do processamento, não a do pedido.
    expect(rows[1]).toHaveTextContent(
      `R$ 80,00Conta · Ag 0001 · ***42 · ${dtm('2026-09-19T14:20:00.000Z')}`,
    );
    expect(within(rows[1]!).getByText('Concluído')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Em processamento')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Falhou')).toBeInTheDocument();
    expect(within(card('Saques')).getAllByRole('button', { name: 'Cancelar' })).toHaveLength(1);
  });

  it('cancelar um saque chama a API com o id dele, avisa e recarrega a carteira', async () => {
    const user = userEvent.setup();
    withdrawals.mockResolvedValueOnce(page([withdrawalOf({ id: 4 })]));
    withdrawals.mockResolvedValue(page([withdrawalOf({ id: 4, status: 'cancelled' })]));
    renderView();

    await user.click(await within(card('Saques')).findByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(cancelWithdrawal).toHaveBeenCalledTimes(1));
    expect(cancelWithdrawal).toHaveBeenCalledWith(4);
    expect(
      await screen.findByText('Saque cancelado. O valor voltou para o saldo.'),
    ).toBeInTheDocument();
    expect(await within(card('Saques')).findByText('Cancelado')).toBeInTheDocument();
    expect(within(card('Saques')).queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(wallet).toHaveBeenCalledTimes(2);
  });

  it('enquanto um cancelamento está indo, os "Cancelar" ficam travados (um por vez)', async () => {
    const user = userEvent.setup();
    withdrawals.mockResolvedValue(
      page([withdrawalOf({ id: 4 }), withdrawalOf({ id: 5, amount: 90 })]),
    );
    let release!: (w: Withdrawal) => void;
    cancelWithdrawal.mockReturnValue(new Promise<Withdrawal>((resolve) => (release = resolve)));
    renderView();

    await within(card('Saques')).findByText('R$ 90,00');
    const [first, second] = within(card('Saques')).getAllByRole('button', { name: 'Cancelar' });
    await user.click(first!);

    await waitFor(() => expect(first).toBeDisabled());
    expect(second).toBeDisabled();
    expect(cancelWithdrawal).toHaveBeenCalledTimes(1);
    expect(cancelWithdrawal).toHaveBeenCalledWith(4);

    release(withdrawalOf({ id: 4, status: 'cancelled' }));
    expect(
      await screen.findByText('Saque cancelado. O valor voltou para o saldo.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(withdrawals).toHaveBeenCalledTimes(2));
  });

  it('se o cancelamento falha, mostra o motivo e o saque continua aguardando', async () => {
    const user = userEvent.setup();
    withdrawals.mockResolvedValue(page([withdrawalOf({ id: 4 })]));
    cancelWithdrawal.mockRejectedValueOnce(new Error('O saque já está em processamento.'));
    cancelWithdrawal.mockRejectedValueOnce(null);
    renderView();

    await user.click(await within(card('Saques')).findByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('O saque já está em processamento.')).toBeInTheDocument();
    expect(within(card('Saques')).getByText('Aguardando')).toBeInTheDocument();

    // Falha sem mensagem: o aviso genérico.
    await user.click(within(card('Saques')).getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Não foi possível cancelar')).toBeInTheDocument();
  });

  it('lista só os seis depósitos mais recentes, com a situação e a data do pagamento', async () => {
    deposits.mockResolvedValue(
      page([
        depositOf({ id: 7, amount: 70, status: 'pending', paidAt: null, pixCode: 'PIX-7' }),
        depositOf({ id: 6, amount: 60, status: 'paid', paidAt: '2026-09-16T11:11:00.000Z' }),
        depositOf({ id: 5, amount: 50, status: 'cancelled', paidAt: null }),
        depositOf({ id: 4, amount: 40, status: 'failed', paidAt: null }),
        depositOf({ id: 3, amount: 30, status: 'refunded' }),
        depositOf({ id: 2, amount: 20, status: 'processing', paidAt: null }),
        depositOf({ id: 1, amount: 999, status: 'paid' }),
      ]),
    );
    renderView();

    await within(card('Depósitos')).findByText('R$ 70,00');
    const rows = within(card('Depósitos')).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(within(card('Depósitos')).queryByText('R$ 999,00')).not.toBeInTheDocument();

    // Pendente: data da criação e o atalho para pagar.
    expect(rows[0]).toHaveTextContent(`PIX · ${dtm('2026-09-15T08:00:00.000Z')}`);
    expect(within(rows[0]!).getByText('Aguardando pagamento')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Pagar' })).toBeInTheDocument();

    expect(rows[1]).toHaveTextContent(`R$ 60,00PIX · ${dtm('2026-09-16T11:11:00.000Z')}`);
    expect(within(rows[1]!).getByText('Confirmado')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Vencido')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Falhou')).toBeInTheDocument();
    expect(within(rows[4]!).getByText('Estornado')).toBeInTheDocument();
    expect(within(rows[5]!).getByText('Processando')).toBeInTheDocument();
    expect(within(card('Depósitos')).getAllByRole('button', { name: 'Pagar' })).toHaveLength(1);
  });

  it('"Pagar" reabre a cobrança pendente com o código PIX dela', async () => {
    const user = userEvent.setup();
    const pending = depositOf({
      id: 7,
      amount: 70,
      status: 'pending',
      paidAt: null,
      pixCode: '00020126PIX-COPIA-E-COLA-7',
      reference: 'dep_7',
    });
    deposits.mockResolvedValue(page([pending]));
    deposit.mockResolvedValue(pending);
    renderView();

    await user.click(await within(card('Depósitos')).findByRole('button', { name: 'Pagar' }));

    const dialog = await screen.findByRole('dialog', { name: 'Depositar na carteira' });
    expect(within(dialog).getByLabelText('PIX copia e cola')).toHaveValue(
      '00020126PIX-COPIA-E-COLA-7',
    );
    expect(within(dialog).getByText('R$ 70,00')).toBeInTheDocument();
    await waitFor(() => expect(deposit).toHaveBeenCalledWith(7));

    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Depositar" abre uma cobrança nova, ainda na escolha do valor', async () => {
    const user = userEvent.setup();
    renderView();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Depositar' }));

    const dialog = screen.getByRole('dialog', { name: 'Depositar na carteira' });
    // O nome acessível guarda o espaço duro do "R$ 100,00": por isso o \s.
    expect(
      within(dialog).getByRole('button', { name: /^Gerar cobrança PIX de R\$\s100,00$/ }),
    ).toBeEnabled();
    expect(within(dialog).queryByLabelText('PIX copia e cola')).not.toBeInTheDocument();
    expect(deposit).not.toHaveBeenCalled();
  });
});

describe('CarteiraView: cartão de saldo', () => {
  it('o saldo vem num cartão com o nome de quem é a carteira, o depósito e o atalho para o saque', async () => {
    renderView();
    const card = (await screen.findByText('Saldo disponível')).closest('section')!;
    expect(card).toHaveClass('bank-card');
    await waitFor(() =>
      expect(within(card).getByTestId('wallet-balance')).toHaveTextContent('R$ 820,50'),
    );
    // Sem perfil carregado, o nome vem do e-mail.
    expect(card.querySelector('.bank-owner')).toHaveTextContent('bruno');
    expect(within(card).getByRole('button', { name: 'Depositar' })).toBeInTheDocument();
    expect(card.querySelector('.bank-deco')).toHaveAttribute('aria-hidden', 'true');
  });

  it('"Pedir saque" leva o foco ao valor do saque', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Pedir saque' }));
    expect(screen.getByRole('spinbutton', { name: /Valor \(R\$\)/ })).toHaveFocus();
  });

  it('sem e-mail confirmado, "Pedir saque" leva ao aviso de confirmação', async () => {
    const user = userEvent.setup();
    auth.user = { id: 1, email: 'bruno@escambo.test', emailVerified: false };
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Pedir saque' }));
    expect(screen.getByTestId('withdraw-locked')).toHaveFocus();
  });
});
