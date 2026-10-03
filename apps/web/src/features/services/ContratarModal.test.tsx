import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { Deposit, Service } from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { ContratarModal } from './ContratarModal';

const wallet = vi.fn();
const publicSettings = vi.fn();
const createContract = vi.fn();
const createDeposit = vi.fn();
const depositStatus = vi.fn();
const simulateDeposit = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    wallet: () => wallet(),
    publicSettings: () => publicSettings(),
    createContract: (body: unknown) => createContract(body),
    createDeposit: (body: unknown) => createDeposit(body),
    deposit: (id: number) => depositStatus(id),
    simulateDeposit: (id: number) => simulateDeposit(id),
  },
}));
// Quem contrata: o fuso muda por teste (o prazo é um dia no fuso de quem entrega, ADR 58).
const auth = vi.hoisted(() => ({
  user: { id: 1, timezone: 'America/Sao_Paulo' } as { id: number; timezone: string | null } | null,
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));
// O depósito sem sair do fluxo desenha um QR Code; o jsdom não tem canvas.
vi.mock('qrcode', () => ({ default: { toCanvas: () => Promise.resolve() } }));

const service = (o: Partial<Service> = {}): Service => ({
  id: 5,
  categoryId: 2,
  ownerId: 9,
  title: 'Logo profissional',
  description: 'Crio a identidade visual da sua marca.',
  priceType: 'fixed',
  price: 200,
  deliveryDays: 7,
  isRemote: true,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  ...o,
});

/** O que a carteira tem agora; os testes mudam antes de abrir o modal (ou no meio, no depósito). */
let funds = { balance: 500, credits: 0 };

const pendingDeposit: Deposit = {
  id: 42,
  amount: 150,
  status: 'pending',
  method: 'pix',
  gateway: 'mock',
  reference: 'DEP-42',
  pixCode: '00020126PIX42',
  expiresAt: null,
  paidAt: null,
  createdAt: '2026-10-01T15:00:00.000Z',
  canSimulate: true,
};

/**
 * 23:59:59 do dia no fuso de quem entrega (Brasília, −03:00, quando o serviço não diz outro): é
 * assim que o prazo escolhido num <input type="date"> vale (ADR 58).
 */
const endOfDay = (day: string, offset = '-03:00'): string =>
  new Date(`${day}T23:59:59${offset}`).toISOString();

/** Para onde o app foi depois da proposta. */
function Where() {
  return <p>Rota: {useLocation().pathname}</p>;
}

function renderModal(s: Service = service()) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/servicos']}>
          <Where />
          <Routes>
            <Route path="*" element={<ContratarModal service={s} onClose={onClose} />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

const cashRadio = () => screen.getByRole('radio', { name: /^Dinheiro/ });
const creditsRadio = () => screen.getByRole('radio', { name: /^Créditos Escambo/ });
const submitButton = () => screen.getByRole('button', { name: 'Enviar proposta' });
const milestonesToggle = () => screen.getByRole('checkbox', { name: /Dividir em marcos/ });
const msTitle = (n: number) => screen.getByLabelText(`Título do marco ${n}`);
const msAmount = (n: number) => screen.getByLabelText(`Valor do marco ${n}`);
const msDue = (n: number) => screen.getByLabelText(`Prazo do marco ${n}`);

/** Espera a carteira chegar: o cartão "Dinheiro" troca o "…" pelo saldo. */
async function walletLoaded(): Promise<void> {
  await waitFor(() => expect(cashRadio()).not.toHaveAccessibleName(/Saldo …/));
}

async function retype(user: UserEvent, field: HTMLElement, value: string): Promise<void> {
  await user.clear(field);
  await user.type(field, value);
}

// "Hoje" é qui, 01/10/2026, meio-dia em Brasília: o prazo sugerido e o mínimo saem daí.
const NOW = '2026-10-01T15:00:00.000Z';
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  vi.setSystemTime(new Date(NOW));
  auth.user = { id: 1, timezone: 'America/Sao_Paulo' };
  funds = { balance: 500, credits: 0 };
  wallet.mockReset();
  wallet.mockImplementation(async () => ({
    balance: funds.balance,
    balancePending: 0,
    currency: 'BRL',
    credits: funds.credits,
    creditsPending: 0,
  }));
  publicSettings.mockReset();
  publicSettings.mockResolvedValue({ platformFeePercentage: 15 });
  createContract.mockReset();
  createContract.mockResolvedValue({ id: 31 });
  createDeposit.mockReset();
  createDeposit.mockResolvedValue(pendingDeposit);
  depositStatus.mockReset();
  depositStatus.mockResolvedValue(pendingDeposit);
  simulateDeposit.mockReset();
});

/** O formulário como abre: o que vem do serviço e o que vai para a API sem mexer em nada. */
describe('ContratarModal: proposta em dinheiro', () => {
  it('abre preenchido pelo serviço: título, descrição, valor e prazo sugerido', async () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'Contratar: Logo profissional' })).toBeVisible();
    expect(screen.getByLabelText('Título')).toHaveValue('Logo profissional');
    expect(screen.getByLabelText('O que você precisa')).toHaveValue(
      'Contratação do serviço "Logo profissional".',
    );
    expect(screen.getByLabelText('Valor')).toHaveValue(200);
    // Hoje (01/10) + os 7 dias do serviço; o mínimo é amanhã.
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-08');
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAttribute('min', '2026-10-02');
    expect(
      screen.getByText(/^Sugerido pelo serviço: 7 dias\. Vale até 23:59 do dia\./),
    ).toBeVisible();
    expect(cashRadio()).toBeChecked();
    expect(milestonesToggle()).not.toBeChecked();
    expect(screen.getByText('R$ 200,00')).toBeInTheDocument();
    expect(
      screen.getByText('reservado agora · freelancer recebe 85% no escrow'),
    ).toBeInTheDocument();
    await walletLoaded();
  });

  it('o cartão "Dinheiro" mostra "…" até a carteira chegar, depois o saldo e a taxa da plataforma', async () => {
    publicSettings.mockResolvedValue({ platformFeePercentage: 12 });
    renderModal();

    // Antes das respostas: sem saldo conhecido e com a taxa padrão de 15%.
    expect(cashRadio()).toHaveAccessibleName(/Saldo … · escrow em R\$ · taxa 15%$/);

    await waitFor(() =>
      expect(cashRadio()).toHaveAccessibleName(/Saldo R\$\s500,00 · escrow em R\$ · taxa 12%$/),
    );
  });

  // Defeito de produção (ContratarModal.tsx, resumo): o cartão "Dinheiro" usa a taxa vigente
  // (platformFeePercentage), mas o resumo escreve "85%" fixo; com taxa de 12% a tela diz "taxa 12%"
  // e "freelancer recebe 85%" ao mesmo tempo.
  it.todo('o resumo diz quanto o freelancer recebe pela taxa vigente (taxa de 12% → 88%)');

  it('serviço com 1 dia de prazo: sugere amanhã e escreve "1 dia"', () => {
    renderModal(service({ deliveryDays: 1 }));

    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-02');
    expect(screen.getByText(/^Sugerido pelo serviço: 1 dia\. /)).toBeInTheDocument();
  });

  it('serviço sem prazo informado: sugere 7 dias', () => {
    renderModal(service({ deliveryDays: null }));

    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-08');
    expect(screen.getByText(/^Sugerido pelo serviço: 7 dias\. /)).toBeInTheDocument();
  });

  it('enviar sem mexer manda o serviço, o freelancer, o valor, dinheiro e o fim do dia do prazo, sem marcos', async () => {
    const user = userEvent.setup({ delay: null });
    const { onClose } = renderModal();
    await walletLoaded();

    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledTimes(1);
    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo profissional',
      description: 'Contratação do serviço "Logo profissional".',
      price: 200,
      paymentMode: 'cash',
      deadlineAt: endOfDay('2026-10-08'),
    });
    expect(
      await screen.findByText('Proposta enviada — valor reservado na sua carteira'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    // A pessoa cai na Sala da contratação que a API criou (o router navega numa transição, que
    // pode chegar depois do aviso: por isso a espera).
    expect(await screen.findByText('Rota: /contratos/31')).toBeInTheDocument();
  });

  it('enviada a proposta, o saldo da carteira é consultado de novo (o valor ficou reservado)', async () => {
    const user = userEvent.setup({ delay: null });
    createContract.mockImplementation(async () => {
      funds.balance = 300; // R$ 200 saíram do saldo e ficaram reservados
      return { id: 31 };
    });
    renderModal();
    await walletLoaded();
    expect(cashRadio()).toHaveAccessibleName(/Saldo R\$\s500,00/);

    await user.click(submitButton());

    await waitFor(() => expect(cashRadio()).toHaveAccessibleName(/Saldo R\$\s300,00/));
    expect(wallet).toHaveBeenCalledTimes(2);
  });

  it('título, descrição, valor e prazo editados são os que vão para a API', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();
    await walletLoaded();

    await retype(user, screen.getByLabelText('Título'), 'Logo para a padaria');
    await retype(
      user,
      screen.getByLabelText('O que você precisa'),
      'Logo e paleta para a fachada nova.',
    );
    await retype(user, screen.getByLabelText('Valor'), '350.5');
    await retype(user, screen.getByLabelText('Prazo de entrega'), '2026-10-20');
    expect(screen.getByText('R$ 350,50')).toBeInTheDocument();
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo para a padaria',
      description: 'Logo e paleta para a fachada nova.',
      price: 350.5,
      paymentMode: 'cash',
      deadlineAt: endOfDay('2026-10-20'),
    });
  });

  it('serviço "a combinar" abre sem valor, e sem valor não dá para enviar', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal(service({ price: null }));
    await walletLoaded();

    expect(screen.getByLabelText('Valor')).toHaveValue(null);
    expect(screen.getByText('R$ 0,00')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    // Sem valor não há o que depositar.
    expect(screen.queryByText(/^Falta /)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Valor'), '120');
    expect(submitButton()).toBeEnabled();
  });

  it('abaixo do mínimo de R$ 10 o envio fica travado', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();
    await walletLoaded();

    await retype(user, screen.getByLabelText('Valor'), '9.99');
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    expect(createContract).not.toHaveBeenCalled();

    await retype(user, screen.getByLabelText('Valor'), '10');
    expect(submitButton()).toBeEnabled();
  });

  it('título e descrição são obrigatórios: em branco, a proposta não sai', async () => {
    const user = userEvent.setup({ delay: null });
    const { onClose } = renderModal();
    await walletLoaded();

    await user.clear(screen.getByLabelText('Título'));
    await user.click(submitButton());
    expect(createContract).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Título'), 'Logo');
    await user.clear(screen.getByLabelText('O que você precisa'));
    await user.click(submitButton());
    expect(createContract).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('O que você precisa'), 'Um logo para a padaria.');
    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Logo', description: 'Um logo para a padaria.' }),
    );
  });

  it('enquanto a proposta é enviada o botão fica travado em "Enviando…"', async () => {
    const user = userEvent.setup({ delay: null });
    let release!: (c: { id: number }) => void;
    createContract.mockImplementation(() => new Promise<{ id: number }>((r) => (release = r)));
    const { onClose } = renderModal();
    await walletLoaded();

    await user.click(submitButton());

    expect(await screen.findByRole('button', { name: 'Enviando…' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Rota: /servicos')).toBeInTheDocument();

    release({ id: 77 });
    expect(await screen.findByText('Rota: /contratos/77')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('API recusa: mostra a mensagem dela, não fecha nem sai da página', async () => {
    const user = userEvent.setup({ delay: null });
    createContract.mockRejectedValue(new Error('Você não pode contratar o próprio serviço.'));
    const { onClose } = renderModal();
    await walletLoaded();

    await user.click(submitButton());

    expect(
      await screen.findByText('Você não pode contratar o próprio serviço.'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Rota: /servicos')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Contratar: Logo profissional' })).toBeVisible();
    expect(submitButton()).toBeEnabled();
  });

  it('falha sem mensagem vira "Erro ao contratar"', async () => {
    const user = userEvent.setup({ delay: null });
    createContract.mockRejectedValue(undefined);
    renderModal();
    await walletLoaded();

    await user.click(submitButton());

    expect(await screen.findByText('Erro ao contratar')).toBeInTheDocument();
  });

  it('o ✕ fecha sem enviar proposta', async () => {
    const user = userEvent.setup({ delay: null });
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Fechar' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createContract).not.toHaveBeenCalled();
  });
});

/** Carteira pré-paga: sem saldo, a proposta espera o depósito, que acontece sem sair do modal. */
describe('ContratarModal: saldo insuficiente', () => {
  it('diz quanto falta, trava o envio e oferece depositar exatamente a diferença', async () => {
    funds.balance = 49.5;
    renderModal();
    await walletLoaded();

    expect(screen.getByText('Falta R$ 150,50 na sua carteira')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Depositar R\$\s150,50$/ })).toBeEnabled();
    expect(submitButton()).toBeDisabled();
  });

  it('saldo que cobre o valor: nada de aviso de depósito', async () => {
    funds.balance = 200;
    renderModal();
    await walletLoaded();

    expect(screen.queryByText(/^Falta /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Depositar/ })).not.toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it('subir o valor acima do saldo passa a pedir o depósito', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();
    await walletLoaded();
    expect(submitButton()).toBeEnabled();

    await retype(user, screen.getByLabelText('Valor'), '620');

    expect(screen.getByText('Falta R$ 120,00 na sua carteira')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('"Depositar" abre o depósito com o que falta (arredondado para cima) e o ✕ volta à proposta', async () => {
    const user = userEvent.setup({ delay: null });
    funds.balance = 49.5;
    const { onClose } = renderModal();
    await walletLoaded();

    await user.click(screen.getByRole('button', { name: /^Depositar R\$\s150,50$/ }));

    expect(screen.getByRole('dialog', { name: 'Depositar na carteira' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: /^Contratar:/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Valor (R$)')).toHaveValue(151);

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.getByRole('dialog', { name: 'Contratar: Logo profissional' })).toBeVisible();
    expect(screen.getByText('Falta R$ 150,50 na sua carteira')).toBeInTheDocument();
    // Fechar o depósito não fecha a contratação.
    expect(onClose).not.toHaveBeenCalled();
    expect(createDeposit).not.toHaveBeenCalled();
  });

  it('depósito confirmado volta à proposta com o que já estava digitado, libera o envio e a proposta segue', async () => {
    const user = userEvent.setup({ delay: null });
    funds.balance = 50;
    simulateDeposit.mockImplementation(async () => {
      funds.balance = 200; // o depósito de R$ 150 entrou
      return { ...pendingDeposit, status: 'paid' };
    });
    renderModal();
    await walletLoaded();
    await retype(user, screen.getByLabelText('Título'), 'Logo para a padaria');

    await user.click(screen.getByRole('button', { name: /^Depositar R\$\s150,00$/ }));
    await user.click(screen.getByRole('button', { name: /^Gerar cobrança PIX de R\$\s150,00$/ }));
    expect(createDeposit).toHaveBeenCalledWith({ amount: 150, method: 'pix' });
    await user.click(await screen.findByRole('button', { name: 'Simular pagamento' }));
    expect(simulateDeposit).toHaveBeenCalledWith(42);

    // Pago: o depósito some e a proposta reaparece do jeito que estava.
    expect(
      await screen.findByRole('dialog', { name: 'Contratar: Logo profissional' }),
    ).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Depositar na carteira' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Título')).toHaveValue('Logo para a padaria');
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(screen.queryByText(/^Falta /)).not.toBeInTheDocument();
    expect(cashRadio()).toHaveAccessibleName(/Saldo R\$\s200,00/);

    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo para a padaria',
      description: 'Contratação do serviço "Logo profissional".',
      price: 200,
      paymentMode: 'cash',
      deadlineAt: endOfDay('2026-10-08'),
    });
  });
});

/** Pagar com créditos Escambo: sem taxa, sem depender do saldo em R$. */
describe('ContratarModal: proposta em créditos', () => {
  it('sem créditos suficientes a opção fica desabilitada e diz quantos precisa', async () => {
    const user = userEvent.setup({ delay: null });
    funds.credits = 50;
    renderModal();
    await walletLoaded();

    expect(creditsRadio()).toBeDisabled();
    expect(creditsRadio()).toHaveAccessibleName(/Você tem 50 · sem taxa · precisa de 200$/);
    await user.click(creditsRadio());
    expect(cashRadio()).toBeChecked();
  });

  it('sem valor definido a opção de créditos fica desabilitada, sem "precisa de"', async () => {
    funds.credits = 50;
    renderModal(service({ price: null }));
    await walletLoaded();

    expect(creditsRadio()).toBeDisabled();
    expect(creditsRadio()).toHaveAccessibleName(/Você tem 50 · sem taxa$/);
  });

  it('com créditos suficientes dá para escolher: o resumo vira créditos e o depósito deixa de ser exigido', async () => {
    const user = userEvent.setup({ delay: null });
    funds = { balance: 0, credits: 300 };
    renderModal();
    await walletLoaded();
    expect(screen.getByText('Falta R$ 200,00 na sua carteira')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(creditsRadio()).toHaveAccessibleName(/Você tem 300 · sem taxa$/);

    await user.click(creditsRadio());

    expect(creditsRadio()).toBeChecked();
    expect(cashRadio()).not.toBeChecked();
    expect(screen.getByText('200 créditos')).toBeInTheDocument();
    expect(screen.getByText('retidos no aceite · liberados na aprovação')).toBeInTheDocument();
    expect(screen.queryByText(/^Falta /)).not.toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it('enviar em créditos manda paymentMode "credits" e avisa que os créditos ficam retidos no aceite', async () => {
    const user = userEvent.setup({ delay: null });
    funds = { balance: 0, credits: 300 };
    const { onClose } = renderModal();
    await walletLoaded();

    await user.click(creditsRadio());
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledTimes(1);
    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo profissional',
      description: 'Contratação do serviço "Logo profissional".',
      price: 200,
      paymentMode: 'credits',
      deadlineAt: endOfDay('2026-10-08'),
    });
    expect(
      await screen.findByText('Proposta enviada — créditos retidos no aceite'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Rota: /contratos/31')).toBeInTheDocument();
  });

  it('o preço em créditos é o valor arredondado: R$ 150,40 custa 150 créditos e R$ 150,60 custa 151', async () => {
    const user = userEvent.setup({ delay: null });
    funds = { balance: 0, credits: 150 };
    renderModal(service({ price: 150.4 }));
    await walletLoaded();

    expect(creditsRadio()).toBeEnabled();
    await user.click(creditsRadio());
    expect(screen.getByText('150 créditos')).toBeInTheDocument();
    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({ price: 150.4, paymentMode: 'credits' }),
    );

    await user.click(cashRadio());
    await retype(user, screen.getByLabelText('Valor'), '150.6');
    expect(creditsRadio()).toBeDisabled();
    expect(creditsRadio()).toHaveAccessibleName(/Você tem 150 · sem taxa · precisa de 151$/);
  });

  // Defeito de produção (ContratarModal.tsx: o modo não volta para "dinheiro" e o envio não olha
  // canCredits): escolhido "Créditos", subir o valor acima dos créditos deixa a opção desabilitada
  // mas marcada, o botão continua liberado e a proposta sai em créditos que a pessoa não tem; a API
  // aceita e só recusa no aceite do freelancer ("Créditos insuficientes do cliente").
  it.todo(
    'subir o valor acima dos créditos depois de escolher "Créditos" volta para dinheiro (ou trava o envio)',
  );

  it('voltar para dinheiro depois de escolher créditos manda "cash" de novo', async () => {
    const user = userEvent.setup({ delay: null });
    funds = { balance: 500, credits: 300 };
    renderModal();
    await walletLoaded();

    await user.click(creditsRadio());
    await user.click(cashRadio());
    expect(screen.getByText('R$ 200,00')).toBeInTheDocument();
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith(expect.objectContaining({ paymentMode: 'cash' }));
  });
});

/** Escrow por marcos (RN-069): 2 a 10 etapas cuja soma é o valor da contratação. */
describe('ContratarModal: dividir em marcos', () => {
  async function openEditor(s: Service = service()) {
    const user = userEvent.setup({ delay: null });
    const view = renderModal(s);
    await walletLoaded();
    await user.click(milestonesToggle());
    return { user, ...view };
  }

  it('marcar abre o editor com duas etapas sem valor, e o envio espera a soma fechar', async () => {
    const { user } = await openEditor();

    expect(msTitle(1)).toHaveValue('Etapa 1');
    expect(msTitle(2)).toHaveValue('Etapa 2');
    expect(msAmount(1)).toHaveValue(null);
    expect(msDue(1)).toHaveValue('');
    expect(screen.queryByLabelText('Título do marco 3')).not.toBeInTheDocument();
    expect(screen.getByText('R$ 0,00 de R$ 200,00')).toBeInTheDocument();
    expect(
      screen.getByText('reservado agora · liberado marco a marco (85% ao freelancer)'),
    ).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    // Desmarcar volta à proposta simples.
    await user.click(milestonesToggle());
    expect(screen.queryByLabelText('Título do marco 1')).not.toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it('"Dividir igualmente" reparte o valor e a proposta vai com os marcos, sem prazo próprio', async () => {
    const { user, onClose } = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));
    expect(msAmount(1)).toHaveValue(100);
    expect(msAmount(2)).toHaveValue(100);
    expect(screen.getByText('R$ 200,00 de R$ 200,00')).toBeInTheDocument();
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledTimes(1);
    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo profissional',
      description: 'Contratação do serviço "Logo profissional".',
      price: 200,
      paymentMode: 'cash',
      deadlineAt: endOfDay('2026-10-08'),
      milestones: [
        { title: 'Etapa 1', amount: 100, dueAt: null },
        { title: 'Etapa 2', amount: 100, dueAt: null },
      ],
    });
    expect(
      await screen.findByText('Proposta enviada em 2 marcos — valor reservado na sua carteira'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('divisão que não fecha em centavos: o último marco absorve a sobra', async () => {
    const { user } = await openEditor(service({ price: 100 }));

    await user.click(screen.getByRole('button', { name: 'Marco' }));
    expect(msTitle(3)).toHaveValue('Etapa 3');
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    expect(msAmount(1)).toHaveValue(33.33);
    expect(msAmount(2)).toHaveValue(33.33);
    expect(msAmount(3)).toHaveValue(33.34);
    expect(screen.getByText('R$ 100,00 de R$ 100,00')).toBeInTheDocument();
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        price: 100,
        milestones: [
          { title: 'Etapa 1', amount: 33.33, dueAt: null },
          { title: 'Etapa 2', amount: 33.33, dueAt: null },
          { title: 'Etapa 3', amount: 33.34, dueAt: null },
        ],
      }),
    );
    expect(
      await screen.findByText('Proposta enviada em 3 marcos — valor reservado na sua carteira'),
    ).toBeInTheDocument();
  });

  it('títulos e valores digitados vão para a API, com o título sem espaços nas pontas', async () => {
    const { user } = await openEditor();

    await retype(user, msTitle(1), '  Esboços  ');
    await retype(user, msTitle(2), 'Arte final');
    await user.type(msAmount(1), '60');
    await user.type(msAmount(2), '140');
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        milestones: [
          { title: 'Esboços', amount: 60, dueAt: null },
          { title: 'Arte final', amount: 140, dueAt: null },
        ],
      }),
    );
  });

  it('soma diferente do valor da contratação trava o envio e mostra quanto está somado', async () => {
    const { user } = await openEditor();

    await user.type(msAmount(1), '100');
    await user.type(msAmount(2), '50');
    expect(screen.getByText('R$ 150,00 de R$ 200,00')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    await retype(user, msAmount(2), '100');
    expect(screen.getByText('R$ 200,00 de R$ 200,00')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();

    // Mudar o valor da contratação depois desfaz o fechamento.
    await retype(user, screen.getByLabelText('Valor'), '250');
    expect(screen.getByText('R$ 200,00 de R$ 250,00')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('marco de valor zero trava o envio mesmo com a soma fechando', async () => {
    const { user } = await openEditor();

    await user.type(msAmount(1), '200');
    await user.type(msAmount(2), '0');
    expect(screen.getByText('R$ 200,00 de R$ 200,00')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    await retype(user, msAmount(1), '199.99');
    await retype(user, msAmount(2), '0.01');
    expect(submitButton()).toBeEnabled();
  });

  it('marco com título de menos de 3 letras trava o envio', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));
    expect(submitButton()).toBeEnabled();

    await retype(user, msTitle(2), 'ab');
    expect(submitButton()).toBeDisabled();

    await user.type(msTitle(2), 'c');
    expect(submitButton()).toBeEnabled();
  });

  it('sem valor na contratação, "Dividir igualmente" não inventa valores nos marcos', async () => {
    const { user } = await openEditor(service({ price: null }));

    await user.type(msAmount(1), '40');
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    expect(msAmount(1)).toHaveValue(40);
    expect(msAmount(2)).toHaveValue(null);
    expect(screen.getByText('R$ 40,00 de R$ 0,00')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('com duas etapas não dá para remover; com três, remover tira a etapa escolhida', async () => {
    const { user } = await openEditor();

    expect(screen.getByRole('button', { name: 'Remover marco 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remover marco 2' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Marco' }));
    expect(screen.getByRole('button', { name: 'Remover marco 2' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Remover marco 2' }));

    expect(msTitle(1)).toHaveValue('Etapa 1');
    expect(msTitle(2)).toHaveValue('Etapa 3');
    expect(screen.queryByLabelText('Título do marco 3')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover marco 1' })).toBeDisabled();
  });

  it('o limite é de 10 marcos: no décimo o botão de adicionar trava', async () => {
    const { user } = await openEditor();
    const add = screen.getByRole('button', { name: 'Marco' });

    for (let i = 3; i <= 10; i += 1) {
      expect(add).toBeEnabled();
      await user.click(add);
    }

    expect(msTitle(10)).toHaveValue('Etapa 10');
    expect(add).toBeDisabled();
    expect(screen.queryByLabelText('Título do marco 11')).not.toBeInTheDocument();
  });

  it('"Distribuir prazos" espalha os marcos até o prazo da contratação, e cada prazo vai como fim do dia', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    await user.click(screen.getByRole('button', { name: 'Distribuir prazos' }));

    // De hoje (01/10) a 08/10 são 7 dias: o primeiro cai em 01/10 + 4 (metade, para cima) = 05/10
    // e o último no prazo.
    expect(msDue(1)).toHaveValue('2026-10-05');
    expect(msDue(2)).toHaveValue('2026-10-08');
    expect(msDue(2)).toHaveAttribute('max', '2026-10-08');
    expect(msDue(2)).toHaveAttribute('min', '2026-10-02');
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineAt: endOfDay('2026-10-08'),
        milestones: [
          { title: 'Etapa 1', amount: 100, dueAt: endOfDay('2026-10-05') },
          { title: 'Etapa 2', amount: 100, dueAt: endOfDay('2026-10-08') },
        ],
      }),
    );
  });

  it('prazo só em um marco: o outro vai sem prazo próprio (null)', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    await user.type(msDue(2), '2026-10-06');
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        milestones: [
          { title: 'Etapa 1', amount: 100, dueAt: null },
          { title: 'Etapa 2', amount: 100, dueAt: endOfDay('2026-10-06') },
        ],
      }),
    );
  });

  it('prazos de marco fora de ordem travam o envio', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    await user.type(msDue(1), '2026-10-07');
    await user.type(msDue(2), '2026-10-06');
    expect(submitButton()).toBeDisabled();

    await retype(user, msDue(2), '2026-10-07');
    expect(submitButton()).toBeEnabled();
  });

  it('marco com prazo depois do prazo da contratação trava o envio; encurtar a contratação também', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    await user.type(msDue(2), '2026-10-09');
    expect(submitButton()).toBeDisabled();
    await retype(user, msDue(2), '2026-10-08');
    expect(submitButton()).toBeEnabled();

    await retype(user, screen.getByLabelText('Prazo de entrega'), '2026-10-06');
    expect(submitButton()).toBeDisabled();
  });

  it('marco com prazo para hoje (antes do mínimo, que é amanhã) trava o envio', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));

    await user.type(msDue(1), '2026-10-01');
    expect(submitButton()).toBeDisabled();

    await retype(user, msDue(1), '2026-10-02');
    expect(submitButton()).toBeEnabled();
  });

  it('em créditos os marcos são inteiros: a divisão arredonda para baixo e o último absorve a sobra', async () => {
    const user = userEvent.setup({ delay: null });
    funds = { balance: 0, credits: 300 };
    const { onClose } = renderModal();
    await walletLoaded();
    await user.click(creditsRadio());
    await user.click(milestonesToggle());
    await user.click(screen.getByRole('button', { name: 'Marco' }));

    expect(screen.getByText('0 cr de 200 cr')).toBeInTheDocument();
    expect(screen.getByText('retidos no aceite · liberados marco a marco')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));
    expect(msAmount(1)).toHaveValue(66);
    expect(msAmount(2)).toHaveValue(66);
    expect(msAmount(3)).toHaveValue(68);
    expect(screen.getByText('200 cr de 200 cr')).toBeInTheDocument();
    await user.click(submitButton());

    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo profissional',
      description: 'Contratação do serviço "Logo profissional".',
      price: 200,
      paymentMode: 'credits',
      deadlineAt: endOfDay('2026-10-08'),
      milestones: [
        { title: 'Etapa 1', amount: 66, dueAt: null },
        { title: 'Etapa 2', amount: 66, dueAt: null },
        { title: 'Etapa 3', amount: 68, dueAt: null },
      ],
    });
    expect(
      await screen.findByText('Proposta enviada em 3 marcos — créditos retidos no aceite'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('em créditos, marco com valor quebrado trava o envio mesmo com a soma fechando', async () => {
    const user = userEvent.setup({ delay: null });
    funds = { balance: 0, credits: 300 };
    renderModal();
    await walletLoaded();
    await user.click(creditsRadio());
    await user.click(milestonesToggle());

    await user.type(msAmount(1), '99.5');
    await user.type(msAmount(2), '100.5');
    expect(screen.getByText('200 cr de 200 cr')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    await retype(user, msAmount(1), '99');
    await retype(user, msAmount(2), '101');
    expect(submitButton()).toBeEnabled();
  });
});

/**
 * O prazo é um dia no fuso de quem entrega (ADR 58): o mínimo é amanhã dele, o padrão é hoje dele
 * mais os dias do serviço, e vai o fim do dia (23:59:59) no fuso dele, no prazo e nos marcos.
 */
describe('ContratarModal: o prazo no fuso de quem entrega', () => {
  const MANAUS = '-04:00';
  const hint = (): string | null => screen.getByTestId('deadline-hint').textContent;
  const OTHER_CLOCK_HINT =
    'Sugerido pelo serviço: 7 dias. Vale até 23:59 do dia, no horário de Manaus (de quem entrega). Em geral na véspera, o Escambo lembra o freelancer do prazo. Sem entrega até lá, a partir das 9h do dia seguinte, também no horário de Manaus, o Escambo avisa vocês dois e você pode cancelar com reembolso integral. O freelancer pode pedir extensão, que só vale com o seu aceite.';
  const SAME_CLOCK_HINT =
    'Sugerido pelo serviço: 7 dias. Vale até 23:59 do dia. Em geral na véspera, o Escambo lembra o freelancer do prazo. Sem entrega até lá, a partir das 9h do dia seguinte o Escambo avisa vocês dois e você pode cancelar com reembolso integral. O freelancer pode pedir extensão, que só vale com o seu aceite.';

  // 23:30 de sex 02/10 em Brasília; 22:30 em Manaus; já 00:30 de sáb 03/10 em Noronha.
  beforeEach(() => vi.setSystemTime(new Date('2026-10-03T02:30:00Z')));

  it('dono em Manaus: o mínimo é amanhã em Manaus, o padrão +7 dias de lá, e vai o fim do dia de Manaus', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal(service({ ownerTimezone: 'America/Manaus' }));
    await walletLoaded();

    expect(screen.getByLabelText('Prazo de entrega')).toHaveAttribute('min', '2026-10-03');
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-09');
    expect(hint()).toBe(OTHER_CLOCK_HINT);

    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledTimes(1);
    expect(createContract).toHaveBeenCalledWith({
      freelancerId: 9,
      serviceId: 5,
      title: 'Logo profissional',
      description: 'Contratação do serviço "Logo profissional".',
      price: 200,
      paymentMode: 'cash',
      deadlineAt: '2026-10-10T03:59:59.000Z', // 09/10, 23:59:59 em Manaus
    });
  });

  it('dono em Manaus: "Distribuir prazos" conta a partir de hoje em Manaus, e os marcos vão como fim do dia de lá', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal(service({ ownerTimezone: 'America/Manaus' }));
    await walletLoaded();
    await user.click(milestonesToggle());
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));
    await user.click(screen.getByRole('button', { name: 'Distribuir prazos' }));

    // De 02/10 (hoje em Manaus) a 09/10 são 7 dias: 02/10 + 4 = 06/10, e o último no prazo.
    expect(msDue(1)).toHaveValue('2026-10-06');
    expect(msDue(2)).toHaveValue('2026-10-09');
    expect(msDue(1)).toHaveAttribute('min', '2026-10-03');
    expect(msDue(1)).toHaveAttribute('max', '2026-10-09');

    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineAt: endOfDay('2026-10-09', MANAUS),
        milestones: [
          { title: 'Etapa 1', amount: 100, dueAt: endOfDay('2026-10-06', MANAUS) },
          { title: 'Etapa 2', amount: 100, dueAt: endOfDay('2026-10-09', MANAUS) },
        ],
      }),
    );
  });

  it('quem contrata em Noronha, já no dia seguinte: o dia continua o de Manaus, de quem entrega', () => {
    auth.user = { id: 1, timezone: 'America/Noronha' };
    renderModal(service({ ownerTimezone: 'America/Manaus', deliveryDays: 1 }));
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAttribute('min', '2026-10-03');
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-03');
    expect(hint()).toBe(OTHER_CLOCK_HINT.replace('7 dias', '1 dia'));
  });

  it('quem contrata em Noronha: "Distribuir prazos" parte de hoje em Manaus, não do dia de quem contrata', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: 1, timezone: 'America/Noronha' };
    renderModal(service({ ownerTimezone: 'America/Manaus', deliveryDays: 6 }));
    await walletLoaded();
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-08');
    await user.click(milestonesToggle());
    await user.click(screen.getByRole('button', { name: 'Dividir igualmente' }));
    await user.click(screen.getByRole('button', { name: 'Distribuir prazos' }));

    // De 02/10 (hoje em Manaus) a 08/10 são 6 dias: 02/10 + 3 = 05/10. Partindo de 03/10 (hoje em
    // Noronha), seriam 5 dias e o primeiro cairia em 06/10.
    expect(msDue(1)).toHaveValue('2026-10-05');
    expect(msDue(2)).toHaveValue('2026-10-08');

    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledTimes(1);
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineAt: endOfDay('2026-10-08', MANAUS),
        milestones: [
          { title: 'Etapa 1', amount: 100, dueAt: endOfDay('2026-10-05', MANAUS) },
          { title: 'Etapa 2', amount: 100, dueAt: endOfDay('2026-10-08', MANAUS) },
        ],
      }),
    );
  });

  it('dono em Cuiabá e quem contrata em Manaus (mesmo relógio): a dica não fala de horário', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: 1, timezone: 'America/Manaus' };
    renderModal(service({ ownerTimezone: 'America/Cuiaba' }));
    await walletLoaded();
    expect(hint()).toBe(SAME_CLOCK_HINT);
    expect(screen.getByLabelText('Prazo de entrega')).toHaveValue('2026-10-09');
    await user.click(submitButton());
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt: endOfDay('2026-10-09', MANAUS) }),
    );
  });

  it('serviço sem o fuso do dono vale Brasília: às 23:30 de lá, o mínimo é amanhã de Brasília e vai o fim do dia de Brasília', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: 1, timezone: 'America/Manaus' };
    renderModal(service());
    await walletLoaded();
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAttribute('min', '2026-10-03');
    expect(hint()).toBe(OTHER_CLOCK_HINT.replace(/Manaus/g, 'Brasília'));
    await user.click(submitButton());
    // 09/10, 23:59:59 em Brasília (no fuso de quem contrata, Manaus, seria uma hora depois).
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAt: '2026-10-10T02:59:59.000Z' }),
    );
  });

  it('o campo do prazo é descrito pela dica, com o horário de quem entrega quando o relógio é outro', () => {
    renderModal(service({ ownerTimezone: 'America/Manaus' }));
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAttribute(
      'aria-describedby',
      'deadline-hint',
    );
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAccessibleDescription(OTHER_CLOCK_HINT);
    cleanup();
    renderModal(service());
    expect(screen.getByLabelText('Prazo de entrega')).toHaveAccessibleDescription(SAME_CLOCK_HINT);
  });

  it('dono em outro relógio: os prazos dos marcos, inclusive o acrescentado, são descritos pela dica', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal(service({ ownerTimezone: 'America/Manaus' }));
    await walletLoaded();
    await user.click(milestonesToggle());
    await user.click(screen.getByRole('button', { name: 'Marco' }));
    for (const n of [1, 2, 3]) {
      expect(msDue(n)).toHaveAttribute('aria-describedby', 'deadline-hint');
      expect(msDue(n)).toHaveAccessibleDescription(OTHER_CLOCK_HINT);
    }
  });

  it.each<[string, string | null, Partial<Service>]>([
    ['os dois em Brasília', 'America/Sao_Paulo', {}],
    [
      'dono em Cuiabá e quem contrata em Manaus (mesmo relógio)',
      'America/Manaus',
      { ownerTimezone: 'America/Cuiaba' },
    ],
  ])(
    'mesmo relógio (%s): os prazos dos marcos não apontam para a dica; fica só o title do campo',
    async (_n, viewer, owner) => {
      const user = userEvent.setup({ delay: null });
      auth.user = { id: 1, timezone: viewer };
      renderModal(service(owner));
      await walletLoaded();
      await user.click(milestonesToggle());
      for (const n of [1, 2]) {
        expect(msDue(n)).not.toHaveAttribute('aria-describedby');
        expect(msDue(n)).toHaveAccessibleDescription('Prazo do marco (opcional)');
      }
      // O campo do prazo da contratação continua descrito pela dica.
      expect(screen.getByLabelText('Prazo de entrega')).toHaveAccessibleDescription(
        SAME_CLOCK_HINT,
      );
    },
  );

  it('sem sessão carregada, quem contrata conta como Brasília', () => {
    auth.user = null;
    renderModal(service({ ownerTimezone: 'America/Manaus' }));
    expect(hint()).toBe(OTHER_CLOCK_HINT);
    auth.user = { id: 1, timezone: null };
    cleanup();
    renderModal(service({ ownerTimezone: 'America/Sao_Paulo' }));
    expect(hint()).toBe(SAME_CLOCK_HINT);
  });
});
