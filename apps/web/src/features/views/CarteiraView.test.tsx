import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CreditTransaction,
  Deposit,
  Wallet,
  WalletTransaction,
  Withdrawal,
} from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const creditTransactions = vi.fn();
const requestWithdrawal = vi.fn();
const cancelWithdrawal = vi.fn();
const resendVerification = vi.fn();
const deposit = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    wallet: () => wallet(),
    publicSettings: () => publicSettings(),
    withdrawals: () => withdrawals(),
    deposits: () => deposits(),
    walletTransactions: () => walletTransactions(),
    creditTransactions: () => creditTransactions(),
    requestWithdrawal: (body: unknown) => requestWithdrawal(body),
    cancelWithdrawal: (id: number) => cancelWithdrawal(id),
    resendVerification: (...args: unknown[]) => resendVerification(...args),
    deposit: (id: number) => deposit(id),
    createDeposit: vi.fn(),
    simulateDeposit: vi.fn(),
  },
}));

const auth = {
  user: { id: 1, email: 'bruno@escambo.test', emailVerified: true } as {
    id: number;
    email: string;
    emailVerified?: boolean;
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
    creditTransactions,
    requestWithdrawal,
    cancelWithdrawal,
    resendVerification,
    deposit,
  ]) {
    fn.mockReset();
  }
  wallet.mockResolvedValue(walletOf());
  publicSettings.mockResolvedValue({ minWithdrawalAmount: 20 });
  withdrawals.mockResolvedValue(page([]));
  deposits.mockResolvedValue(page([]));
  walletTransactions.mockResolvedValue(page([]));
  creditTransactions.mockResolvedValue(page([]));
  requestWithdrawal.mockResolvedValue(withdrawalOf({ id: 99 }));
  cancelWithdrawal.mockResolvedValue(withdrawalOf({ id: 99, status: 'cancelled' }));
  resendVerification.mockResolvedValue(undefined);
});

describe('CarteiraView: saldos e estados', () => {
  it('enquanto nada chegou: saldos com travessão, três esqueletos e o mínimo padrão de R$ 20', () => {
    const never = new Promise(() => undefined);
    for (const fn of [wallet, publicSettings, withdrawals, deposits, walletTransactions]) {
      fn.mockReturnValue(never);
    }
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: 'Carteira' })).toBeInTheDocument();
    expect(kpi('Saldo disponível')).toHaveTextContent('Saldo disponível—para contratar ou sacar');
    expect(kpi('Retido')).toHaveTextContent('Retido—reservado em propostas ou em escrow');
    expect(kpi('Créditos Escambo')).toHaveTextContent('Créditos Escambo—para contratar');
    expect(screen.getAllByRole('status', { name: 'Carregando' })).toHaveLength(3);
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

describe('CarteiraView: pedir saque', () => {
  it('o mínimo do saque vem das configurações da plataforma', async () => {
    publicSettings.mockResolvedValue({ minWithdrawalAmount: 35 });
    renderView();

    expect(await screen.findByLabelText('Valor (R$) · mínimo R$ 35,00')).toHaveAttribute(
      'min',
      '35',
    );
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
