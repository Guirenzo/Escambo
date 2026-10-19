import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractOffer, ContractWithHistory } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { statusLabel } from '../../lib/format';
import { CounterOfferModal } from './CounterOfferModal';
import { AcceptCounterModal } from './AcceptCounterModal';
import { NegotiationDueNotice, NegotiationSection } from './NegotiationSection';

const mocks = vi.hoisted(() => ({
  wallet: vi.fn(),
  counterOffer: vi.fn(),
  acceptCounterOffer: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: mocks }));
const auth = vi.hoisted(() => ({ user: { id: 1, timezone: 'America/Sao_Paulo' } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));
vi.mock('../wallet/DepositModal', () => ({
  DepositModal: ({
    suggestedAmount,
    onClose,
  }: {
    suggestedAmount: number;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Depositar">
      <p>Depósito sugerido: {suggestedAmount}</p>
      <button onClick={onClose}>Voltar ao formulário</button>
    </div>
  ),
}));

const offer = (patch: Partial<ContractOffer> = {}): ContractOffer => ({
  seq: 2,
  madeBy: 'freelancer',
  price: 120,
  platformFee: 18,
  freelancerNet: 102,
  deadlineAt: '2026-10-15T03:59:59.000Z',
  deadlineZone: 'America/Manaus',
  milestones: null,
  message: 'Preciso ajustar o valor',
  respondBy: '2026-10-10T15:00:00.000Z',
  outcome: 'open',
  createdAt: '2026-10-08T15:00:00.000Z',
  resolvedAt: null,
  ...patch,
});
const contract = (
  current = offer(),
  patch: Partial<ContractWithHistory> = {},
): ContractWithHistory =>
  ({
    id: 9,
    clientId: 1,
    freelancerId: 2,
    title: 'Vídeo',
    status: 'pending',
    price: 150,
    platformFee: 22.5,
    freelancerNet: 127.5,
    deadlineAt: current.deadlineAt,
    deadlineZone: current.deadlineZone,
    paymentMode: 'cash',
    hasMilestones: Boolean(current.milestones),
    negotiation: {
      seq: current.seq,
      round: Math.ceil(current.seq / 2) as 1 | 2 | 3,
      turn: current.seq % 2 ? 'freelancer' : 'client',
      feePercentage: 15,
      canCounter: current.seq < 5,
      countersLeft: Math.ceil((5 - current.seq) / 2),
      current,
      respondBy: current.respondBy,
    },
    offers: [current],
    ...patch,
  }) as ContractWithHistory;

function wrap(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, invalidate };
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const loaded = async () => waitFor(() => expect(mocks.wallet).toHaveBeenCalled());
const plain = (s: string | null) => (s ?? '').replace(/\u00a0/g, ' ');

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  auth.user.id = 1;
  vi.clearAllMocks();
  mocks.wallet.mockResolvedValue({
    balance: 500,
    balancePending: 150,
    credits: 500,
    creditsPending: 0,
    currency: 'BRL',
  });
  mocks.counterOffer.mockResolvedValue(contract(offer({ seq: 3, madeBy: 'client' })));
  mocks.acceptCounterOffer.mockResolvedValue(
    contract(offer(), { status: 'accepted', negotiation: null }),
  );
});

describe('negociação na Sala e histórico', () => {
  it.each([
    [3, 'client' as const, 1, 'Contraproposta do cliente', 'vez do freelancer'],
    [2, 'freelancer' as const, 2, 'Contraproposta do freelancer', 'vez do cliente'],
  ])('oferta %i traduz o autor e a vez em toda a seção', (seq, madeBy, myId, author, turn) => {
    wrap(<NegotiationSection contract={contract(offer({ seq, madeBy }))} myId={myId} />);
    fireEvent.click(screen.getByText('Como a proposta foi negociada (1 ofertas)'));
    expect(screen.getByText(turn, { exact: true })).toBeVisible();
    const authors = screen.getAllByText(author, { exact: true });
    expect(authors).toHaveLength(2);
    for (const text of authors) expect(text).toBeVisible();
    expect(screen.queryByText(/\bclient\b/)).toBeNull();
  });
  it('API antiga não cria seção nem status em negociação', () => {
    const c = contract(offer(), { negotiation: undefined, offers: undefined });
    wrap(<NegotiationSection contract={c} myId={1} />);
    expect(screen.queryByTestId('negotiation')).toBeNull();
    expect(statusLabel(c)).toBe('Pendente');
  });
  it('destaca a vez do cliente, o delta sobre a reserva do cliente e o prazo no fuso da entrega', () => {
    wrap(<NegotiationSection contract={contract()} myId={1} />);
    expect(screen.getByText('sua vez')).toBeVisible();
    expect(screen.getByText(/rodada 1 de 3/)).toBeVisible();
    expect(plain(screen.getByTestId('reserve-preview').textContent)).toContain(
      'R$ 30,00 volta para o seu saldo',
    );
    expect(screen.getAllByText(/horário de Manaus/).length).toBeGreaterThan(0);
    expect(statusLabel(contract())).toBe('Em negociação');
  });
  it('histórico ordenado sobrevive ao aceite e conserva mensagem/valores/outcome', () => {
    const first = offer({
      seq: 1,
      madeBy: 'client',
      price: 150,
      message: null,
      outcome: 'countered',
    });
    const accepted = offer({ outcome: 'accepted' });
    wrap(
      <NegotiationSection
        contract={contract(accepted, {
          status: 'accepted',
          negotiation: null,
          offers: [accepted, first],
        })}
        myId={1}
      />,
    );
    fireEvent.click(screen.getByText('Como a proposta foi negociada (2 ofertas)'));
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Proposta do cliente');
    expect(items[1]).toHaveTextContent('Contraproposta do freelancer');
    expect(within(items[1]!).getByText('Aceita')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Preciso ajustar o valor');
    expect(screen.queryByText('sua vez')).toBeNull();
    expect(statusLabel(contract(accepted, { status: 'accepted', negotiation: null }))).toBe(
      'Aceito',
    );
  });
  it('aviso do freelancer na rodada final não promete outra contraproposta', () => {
    const c = contract(offer({ seq: 5, madeBy: 'client' }));
    wrap(<NegotiationDueNotice contract={c} myId={2} zone="America/Sao_Paulo" />);
    expect(screen.getByTestId('proposal-due')).toHaveTextContent(
      'aceite, recuse. Esta é a oferta final',
    );
    expect(screen.getByTestId('proposal-due')).not.toHaveTextContent('ou contraponha');
  });
  it('aviso do freelancer esperando o cliente inclui o valor proposto', () => {
    wrap(<NegotiationDueNotice contract={contract()} myId={2} zone="America/Sao_Paulo" />);
    expect(plain(screen.getByTestId('proposal-due').textContent)).toContain(
      'sua contraproposta de R$ 120,00',
    );
  });
});

describe('CounterOfferModal', () => {
  it('a prévia do líquido usa a taxa histórica fracionária entregue pela API', () => {
    auth.user.id = 2;
    const c = contract(
      offer({ seq: 1, madeBy: 'client', price: 10.01, platformFee: 1.25, freelancerNet: 8.76 }),
    );
    c.negotiation!.feePercentage = 12.5;
    wrap(<CounterOfferModal contract={c} onClose={vi.fn()} />);
    change('Valor (R$)', '20');
    const preview = screen.getByText(/Líquido estimado para você/);
    expect(plain(preview.textContent)).toContain('R$ 17,50');
    expect(preview).toHaveTextContent('taxa 12.5% da proposta original');
  });
  it('usa o fuso atual do freelancer nas datas enviadas, mantendo os dias da oferta legada', async () => {
    auth.user.id = 2;
    const c = contract(offer({ seq: 1, madeBy: 'client' }));
    c.negotiation!.deadlineZone = 'America/Sao_Paulo';
    wrap(<CounterOfferModal contract={c} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-14');
    expect(
      screen.getByText(/Os novos prazos valem até 23:59 no horário de Brasília/),
    ).toHaveTextContent('oferta anterior, no horário de Manaus');
    change('O que muda e por quê (o cliente lê antes de decidir)', 'Mudança do preço');
    expect(screen.getByRole('button', { name: 'Enviar contraproposta' })).toBeDisabled();
    change('Valor (R$)', '130');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enviar contraproposta' }));
    expect(mocks.counterOffer).toHaveBeenCalledWith(9, {
      seq: 1,
      price: 130,
      deadlineAt: '2026-10-15T02:59:59.000Z',
      message: 'Mudança do preço',
    });
  });
  it('preserva ids, títulos, modo, fuso e seq ao editar valor e ratear os marcos', async () => {
    auth.user.id = 2;
    const current = offer({
      seq: 3,
      madeBy: 'client',
      milestones: [
        { id: 71, title: 'Roteiro', amount: 50, freelancerNet: 42.5, dueAt: null },
        { id: 93, title: 'Edição', amount: 70, freelancerNet: 59.5, dueAt: null },
      ],
    });
    const onClose = vi.fn();
    wrap(<CounterOfferModal contract={contract(current)} onClose={onClose} />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remover marco/ })).toBeNull();
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-14');
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAttribute('min', '2026-10-09');
    change('Valor (R$)', '200.01');
    fireEvent.click(screen.getByRole('button', { name: 'Dividir igualmente' }));
    expect(screen.getByLabelText('Valor do marco 1')).toHaveValue(100);
    expect(screen.getByLabelText('Valor do marco 2')).toHaveValue(100.01);
    change('Prazo de entrega', '2026-10-16');
    change('O que muda e por quê (o cliente lê antes de decidir)', '  Novo valor e prazo  ');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enviar contraproposta' }));
    expect(mocks.counterOffer).toHaveBeenCalledWith(9, {
      seq: 3,
      price: 200.01,
      deadlineAt: '2026-10-17T03:59:59.000Z',
      message: 'Novo valor e prazo',
      milestones: [
        { id: 71, amount: 100, dueAt: null },
        { id: 93, amount: 100.01, dueAt: null },
      ],
    });
    expect(await screen.findByText(/Contraproposta enviada\. Resposta até/)).toBeVisible();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('sem mudança de termos não envia, ainda que a mensagem seja válida', () => {
    wrap(<CounterOfferModal contract={contract()} onClose={vi.fn()} />);
    change('O que muda e por quê (o freelancer lê antes de decidir)', 'Só quero explicar');
    expect(screen.getByRole('button', { name: 'Enviar contraproposta' })).toBeDisabled();
    expect(screen.getByText(/Só a mensagem não cria/)).toBeVisible();
  });
  it('depósito usa só o déficit do delta da reserva e preserva os campos ao voltar', async () => {
    mocks.wallet.mockResolvedValue({ balance: 20, credits: 0 });
    wrap(<CounterOfferModal contract={contract()} onClose={vi.fn()} />);
    change('Valor (R$)', '200');
    change('O que muda e por quê (o freelancer lê antes de decidir)', 'Novo valor para escopo');
    await screen.findByRole('button', { name: 'Depositar' });
    expect(screen.getByRole('button', { name: 'Enviar contraproposta' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Depositar' }));
    expect(screen.getByText('Depósito sugerido: 30')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Voltar ao formulário' }));
    expect(screen.getByLabelText('Valor (R$)')).toHaveValue(200);
    expect(screen.getByLabelText(/O que muda/)).toHaveValue('Novo valor para escopo');
    expect(mocks.counterOffer).not.toHaveBeenCalled();
  });
  it('créditos não reservam na contraproposta e continuam inteiros', async () => {
    const current = offer({ deadlineAt: null, platformFee: 0, freelancerNet: 120 });
    wrap(
      <CounterOfferModal
        contract={contract(current, { paymentMode: 'credits' })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Prazo de entrega')).toBeNull();
    change('Valor em créditos', '125');
    change('O que muda e por quê (o freelancer lê antes de decidir)', 'Mais cinco créditos');
    expect(screen.getByText(/Não há reserva durante a negociação/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Depositar' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enviar contraproposta' }));
    expect(mocks.counterOffer).toHaveBeenCalledWith(9, {
      seq: 2,
      price: 125,
      deadlineAt: null,
      message: 'Mais cinco créditos',
    });
  });
  it('erro da API aparece sem sucesso, recarrega a oferta/reserva e não fecha o modal', async () => {
    const onClose = vi.fn();
    const failure = new Error('A oferta mudou. Confira a negociação antes de decidir.');
    mocks.counterOffer.mockRejectedValue(failure);
    const { invalidate } = wrap(<CounterOfferModal contract={contract()} onClose={onClose} />);
    change('Valor (R$)', '160');
    change('O que muda e por quê (o freelancer lê antes de decidir)', 'Outro valor');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Enviar contraproposta' })).toBeEnabled(),
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enviar contraproposta' }));
    expect(await screen.findByText(failure.message)).toBeVisible();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['contract', 9] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['wallet'] });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Contraproposta enviada/)).toBeNull();
  });
});

describe('AcceptCounterModal', () => {
  it('uma oferta menor devolve o excedente e permite aceitar sem saldo disponível', async () => {
    mocks.wallet.mockResolvedValue({ balance: 0, credits: 0 });
    const onClose = vi.fn();
    wrap(<AcceptCounterModal contract={contract()} onClose={onClose} />);
    expect(plain(screen.getByTestId('reserve-preview').textContent)).toContain(
      'R$ 30,00 volta para o seu saldo',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Aceitar e contratar' })).toBeEnabled(),
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Aceitar e contratar' }));
    expect(mocks.acceptCounterOffer).toHaveBeenCalledWith(9, 2);
    expect(await screen.findByText(/Contraproposta aceita/)).toBeVisible();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('oferta maior exige apenas diferença da reserva e oferece depósito antes de contratar', async () => {
    mocks.wallet.mockResolvedValue({ balance: 20, credits: 0 });
    wrap(<AcceptCounterModal contract={contract(offer({ price: 200 }))} onClose={vi.fn()} />);
    const deposit = await screen.findByRole('button', { name: 'Depositar' });
    expect(plain(within(screen.getByRole('dialog')).getByRole('status').textContent)).toContain(
      'Faltam R$ 30,00',
    );
    expect(screen.getByRole('button', { name: 'Aceitar e contratar' })).toBeDisabled();
    await userEvent.setup().click(deposit);
    expect(screen.getByText('Depósito sugerido: 30')).toBeVisible();
    expect(mocks.acceptCounterOffer).not.toHaveBeenCalled();
  });
  it('créditos são debitados no aceite, saldo insuficiente não habilita nem oferece PIX', async () => {
    mocks.wallet.mockResolvedValue({ balance: 1000, credits: 119 });
    wrap(
      <AcceptCounterModal
        contract={contract(offer({ platformFee: 0, freelancerNet: 120 }), {
          paymentMode: 'credits',
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/120 créditos serão debitados/)).toBeVisible();
    expect(await screen.findByText(/Faltam 1 créditos/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Aceitar e contratar' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Depositar' })).toBeNull();
  });
  it('mudança de seq com modal aberto não aceita uma oferta diferente da vista', async () => {
    const initial = contract();
    const { rerender, client } = wrap(<AcceptCounterModal contract={initial} onClose={vi.fn()} />);
    await loaded();
    rerender(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <AcceptCounterModal contract={contract(offer({ seq: 4 }))} onClose={vi.fn()} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('A oferta mudou');
    expect(screen.getByRole('button', { name: 'Aceitar e contratar' })).toBeDisabled();
    expect(mocks.acceptCounterOffer).not.toHaveBeenCalled();
  });
  it.each([
    ['oferta expirada', offer({ respondBy: '2026-10-08T15:00:00Z' }), 1],
    ['prazo de entrega vencido', offer({ deadlineAt: '2026-10-08T14:59:59Z' }), 1],
    ['vez do freelancer', offer({ seq: 3 }), 1],
    ['freelancer tenta aceitar a própria oferta', offer(), 2],
  ])('%s não permite contratação', async (_label, current, userId) => {
    auth.user.id = userId;
    wrap(<AcceptCounterModal contract={contract(current)} onClose={vi.fn()} />);
    await loaded();
    expect(screen.getByRole('button', { name: 'Aceitar e contratar' })).toBeDisabled();
    expect(mocks.acceptCounterOffer).not.toHaveBeenCalled();
  });
});
