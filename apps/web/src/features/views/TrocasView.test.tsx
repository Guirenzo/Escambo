import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BarterAgreement, Deposit, Service } from '@escambo/types';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dt } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { TrocasView } from './TrocasView';

/**
 * Trocas (escambo): serviço por serviço, com a torna paga por quem recebe o serviço mais valioso
 * e a taxa só sobre a torna (RN-066). A tela diz quem paga quanto antes de enviar, não deixa
 * propor nem aceitar sem saldo para a torna e oferece o depósito ali mesmo.
 */

const barters = vi.fn();
const listServices = vi.fn();
const wallet = vi.fn();
const publicSettings = vi.fn();
const proposeBarter = vi.fn();
const barterAction = vi.fn();
const createDeposit = vi.fn();
const simulateDeposit = vi.fn();
const deposit = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    barters: () => barters(),
    listServices: (params: unknown) => listServices(params),
    wallet: () => wallet(),
    publicSettings: () => publicSettings(),
    proposeBarter: (body: unknown) => proposeBarter(body),
    barterAction: (id: number, action: string) => barterAction(id, action),
    createDeposit: (body: unknown) => createDeposit(body),
    simulateDeposit: (id: number) => simulateDeposit(id),
    deposit: (id: number) => deposit(id),
  },
}));

vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 1 } }) }));

// O jsdom não desenha em canvas: o QR Code do depósito fica de fora (a tela não depende dele).
vi.mock('qrcode', () => ({ default: { toCanvas: () => Promise.resolve() } }));

/** A busca da URL depois que a tela mexe nela (o "?propor=" some ao abrir o formulário). */
function Search() {
  const { search } = useLocation();
  return <p>busca: {search || 'vazia'}</p>;
}

function renderView(entry = '/trocas') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <TrocasView />
          <Search />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const ME = 1;

const serviceOf = (o: Partial<Service> & { id: number; ownerId: number }): Service => ({
  categoryId: 1,
  title: `Serviço ${o.id}`,
  description: '',
  priceType: 'fixed',
  price: 100,
  deliveryDays: 5,
  isRemote: true,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  ...o,
});

const SERVICES: Service[] = [
  serviceOf({ id: 10, ownerId: 2, title: 'Logo profissional', price: 300 }),
  serviceOf({ id: 11, ownerId: 3, title: 'Consultoria de marca', price: null }),
  serviceOf({ id: 20, ownerId: ME, title: 'Edição de vídeo', price: 200 }),
  serviceOf({ id: 21, ownerId: ME, title: 'Aula de inglês', price: 80 }),
];

const barterOf = (o: Partial<BarterAgreement> & { id: number }): BarterAgreement => ({
  ulid: `b-${o.id}`,
  proposerId: ME,
  receiverId: 2,
  offeredServiceId: 20,
  requestedServiceId: 10,
  offeredServiceTitle: 'Edição de vídeo',
  requestedServiceTitle: 'Logo profissional',
  offeredDescription: null,
  requestedDescription: null,
  estimatedValueOffered: 200,
  estimatedValueRequested: 300,
  cashDifference: 100,
  cashPayerId: ME,
  platformFee: 15,
  tornaNet: 85,
  tornaStatus: 'held',
  status: 'proposed',
  contractOfferedId: null,
  contractRequestedId: null,
  createdAt: '2026-09-20T15:00:00.000Z',
  ...o,
});

const page = <T,>(items: T[]) => ({ items, page: 1, limit: 100 });

const walletOf = (balance: number) => ({
  balance,
  balancePending: 0,
  currency: 'BRL',
  credits: 0,
  creditsPending: 0,
});

/** Texto de um elemento com espaço comum no lugar do espaço duro do "R$ 10,00". */
const plain = (el: Element) => (el.textContent ?? '').replace(/\s/g, ' ');

beforeEach(() => {
  for (const fn of [
    barters,
    listServices,
    wallet,
    publicSettings,
    proposeBarter,
    barterAction,
    createDeposit,
    simulateDeposit,
    deposit,
  ]) {
    fn.mockReset();
  }
  barters.mockResolvedValue(page([]));
  listServices.mockResolvedValue(page(SERVICES));
  wallet.mockResolvedValue(walletOf(500));
  publicSettings.mockResolvedValue({ platformFeePercentage: 15, barterEnabled: true });
  proposeBarter.mockResolvedValue(barterOf({ id: 50 }));
  barterAction.mockResolvedValue(undefined);
});

/** Abre o formulário (os serviços já chegaram) e devolve os campos. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  const open = screen.getByRole('button', { name: 'Propor troca' });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  return {
    target: screen.getByLabelText('Eu quero (serviço de outro freelancer)'),
    value: screen.getByLabelText('Valor estimado da minha oferta (R$)'),
    submit: screen.getByRole('button', { name: 'Enviar proposta' }),
  };
}

describe('TrocasView: lista de trocas', () => {
  it('enquanto carrega: esqueleto, e "Propor troca" travado até haver serviço de outra pessoa', () => {
    const never = new Promise(() => undefined);
    barters.mockReturnValue(never);
    listServices.mockReturnValue(never);
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: 'Trocas' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propor troca' })).toBeDisabled();
    expect(listServices).toHaveBeenCalledWith({ limit: 100 });
    expect(document.title).toBe('Trocas · Escambo');
  });

  it('sem trocas, convida a propor a primeira', async () => {
    renderView();

    expect(await screen.findByText('Nenhuma troca ainda. Proponha a primeira!')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Propor troca' })).toBeEnabled());
  });

  it('só com serviços meus no catálogo, não há com quem trocar: o botão fica travado', async () => {
    listServices.mockResolvedValue(page(SERVICES.filter((s) => s.ownerId === ME)));
    renderView();

    await screen.findByText('Nenhuma troca ainda. Proponha a primeira!');
    await waitFor(() => expect(listServices).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Propor troca' })).toBeDisabled();
  });

  it('o subtítulo diz a taxa que a plataforma pratica sobre a torna', async () => {
    publicSettings.mockResolvedValue({ platformFeePercentage: 10, barterEnabled: true });
    renderView();

    expect(
      await screen.findByText(/a plataforma retém 10% só sobre a torna\.$/),
    ).toBeInTheDocument();
  });

  it('troca que eu propus: o que ofereço, o que recebo, a torna que pago e só "Cancelar"', async () => {
    barters.mockResolvedValue(page([barterOf({ id: 1 })]));
    renderView();

    // O cartão da troca não tem papel acessível: o identificador de teste é o que o delimita.
    const card = await screen.findByTestId('barter-1');
    expect(within(card).getByText('Você propôs')).toBeInTheDocument();
    expect(within(card).getByText('Proposta')).toBeInTheDocument();
    expect(plain(card)).toContain('Você ofereceEdição de vídeoR$ 200,00');
    expect(plain(card)).toContain('Você recebeLogo profissionalR$ 300,00');
    expect(within(card).getByText('Você paga R$ 100,00 de torna · torna reservada')).toBeVisible();
    expect(within(card).getByText(dt('2026-09-20T15:00:00.000Z'))).toBeInTheDocument();
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Cancelar']);
  });

  it('troca recebida: o que oferecem, o que querem, a torna líquida que recebo, aceitar e recusar', async () => {
    barters.mockResolvedValue(
      page([
        barterOf({
          id: 2,
          proposerId: 3,
          receiverId: ME,
          offeredServiceId: null,
          offeredServiceTitle: null,
          offeredDescription: 'Fotos do cardápio',
          requestedServiceId: 20,
          requestedServiceTitle: null,
          estimatedValueOffered: 150,
          estimatedValueRequested: 200,
          cashDifference: 50,
          cashPayerId: 3,
          platformFee: 7.5,
          tornaNet: 42.5,
        }),
      ]),
    );
    renderView();

    const card = await screen.findByTestId('barter-2');
    expect(within(card).getByText('Recebida')).toBeInTheDocument();
    // Sem título gravado, a oferta descrita aparece como foi escrita.
    expect(plain(card)).toContain('OferecemFotos do cardápioR$ 150,00');
    // Sem título gravado, o serviço pedido vem do catálogo, pelo id.
    await waitFor(() => expect(plain(card)).toContain('QueremEdição de vídeoR$ 200,00'));
    expect(
      within(card).getByText('Você recebe R$ 42,50 de torna (taxa R$ 7,50) · torna reservada'),
    ).toBeVisible();
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Aceitar', 'Recusar']);
  });

  it('serviço fora do catálogo aparece pelo número; sem serviço nem descrição, um travessão', async () => {
    barters.mockResolvedValue(
      page([
        barterOf({
          id: 3,
          offeredServiceId: null,
          offeredServiceTitle: null,
          requestedServiceId: 99,
          requestedServiceTitle: null,
          estimatedValueOffered: 300,
          cashDifference: 0,
          cashPayerId: null,
          tornaStatus: 'none',
          status: 'active',
        }),
      ]),
    );
    renderView();

    const card = await screen.findByTestId('barter-3');
    expect(plain(card)).toContain('Você oferece—R$ 300,00');
    expect(plain(card)).toContain('Você recebeServiço #99R$ 300,00');
  });

  it('troca equilibrada em andamento: sem torna, avisa dos dois contratos e não tem ação', async () => {
    barters.mockResolvedValue(
      page([
        barterOf({
          id: 3,
          estimatedValueOffered: 300,
          cashDifference: 0,
          cashPayerId: null,
          platformFee: 0,
          tornaNet: 0,
          tornaStatus: 'none',
          status: 'active',
        }),
      ]),
    );
    renderView();

    const card = await screen.findByTestId('barter-3');
    expect(within(card).getByText('Em andamento')).toBeInTheDocument();
    expect(within(card).getByText('Sem torna')).toBeInTheDocument();
    expect(
      within(card).getByText('2 contratos recíprocos gerados — acompanhe em Início'),
    ).toBeVisible();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('troca encerrada mostra a situação em português e nenhuma ação', async () => {
    barters.mockResolvedValue(
      page([
        barterOf({ id: 4, status: 'rejected', tornaStatus: 'refunded' }),
        barterOf({ id: 5, status: 'completed', tornaStatus: 'paid' }),
        barterOf({ id: 6, status: 'cancelled', tornaStatus: 'refunded' }),
      ]),
    );
    renderView();

    const rejected = await screen.findByTestId('barter-4');
    expect(within(rejected).getByText('Recusada')).toBeInTheDocument();
    expect(within(rejected).getByText(/· torna devolvida$/)).toBeInTheDocument();
    expect(within(screen.getByTestId('barter-5')).getByText('Concluída')).toBeInTheDocument();
    expect(within(screen.getByTestId('barter-5')).getByText(/· torna paga$/)).toBeInTheDocument();
    expect(within(screen.getByTestId('barter-6')).getByText('Cancelada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceitar' })).not.toBeInTheDocument();
  });

  it('falha ao buscar as trocas: mostra o erro e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    barters.mockRejectedValueOnce(new Error('Não deu para carregar as trocas.'));
    barters.mockResolvedValue(page([barterOf({ id: 1 })]));
    renderView();

    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para carregar as trocas.');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByTestId('barter-1')).toBeInTheDocument();
    expect(barters).toHaveBeenCalledTimes(2);
  });
});

describe('TrocasView: responder a uma troca', () => {
  const received = barterOf({
    id: 2,
    proposerId: 3,
    receiverId: ME,
    cashPayerId: 3,
    cashDifference: 50,
    tornaNet: 42.5,
    platformFee: 7.5,
  });

  it('aceitar, recusar e cancelar chamam a API com a troca e a ação, avisam e recarregam', async () => {
    const user = userEvent.setup();
    barters.mockResolvedValue(page([barterOf({ id: 1 }), received]));
    renderView();

    await user.click(
      within(await screen.findByTestId('barter-2')).getByRole('button', { name: 'Aceitar' }),
    );
    await waitFor(() => expect(barterAction).toHaveBeenLastCalledWith(2, 'accept'));
    expect(await screen.findByText('Troca atualizada')).toBeInTheDocument();
    await waitFor(() => expect(barters).toHaveBeenCalledTimes(2));

    const refuse = within(screen.getByTestId('barter-2')).getByRole('button', { name: 'Recusar' });
    await waitFor(() => expect(refuse).toBeEnabled());
    await user.click(refuse);
    await waitFor(() => expect(barterAction).toHaveBeenLastCalledWith(2, 'reject'));

    const cancel = within(screen.getByTestId('barter-1')).getByRole('button', { name: 'Cancelar' });
    await waitFor(() => expect(cancel).toBeEnabled());
    await user.click(cancel);
    await waitFor(() => expect(barterAction).toHaveBeenLastCalledWith(1, 'cancel'));
    expect(barterAction).toHaveBeenCalledTimes(3);
  });

  it('enquanto uma ação está indo, os botões de todas as trocas ficam travados', async () => {
    const user = userEvent.setup();
    barters.mockResolvedValue(page([barterOf({ id: 1 }), received]));
    let release!: () => void;
    barterAction.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    renderView();

    const mine = await screen.findByTestId('barter-1');
    const theirs = screen.getByTestId('barter-2');
    await user.click(within(theirs).getByRole('button', { name: 'Aceitar' }));

    await waitFor(() =>
      expect(within(theirs).getByRole('button', { name: 'Aceitar' })).toBeDisabled(),
    );
    expect(within(theirs).getByRole('button', { name: 'Recusar' })).toBeDisabled();
    expect(within(mine).getByRole('button', { name: 'Cancelar' })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(within(mine).getByRole('button', { name: 'Cancelar' })).toBeEnabled(),
    );
  });

  it('se a API recusa a ação, mostra o motivo (ou o aviso genérico) e não diz que atualizou', async () => {
    const user = userEvent.setup();
    barters.mockResolvedValue(page([received]));
    barterAction.mockRejectedValueOnce(new Error('Esta troca já foi respondida.'));
    barterAction.mockRejectedValueOnce(undefined);
    renderView();

    const card = await screen.findByTestId('barter-2');
    await user.click(within(card).getByRole('button', { name: 'Aceitar' }));
    expect(await screen.findByText('Esta troca já foi respondida.')).toBeInTheDocument();

    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Recusar' })).toBeEnabled(),
    );
    await user.click(within(card).getByRole('button', { name: 'Recusar' }));
    expect(await screen.findByText('Erro')).toBeInTheDocument();
    expect(screen.queryByText('Troca atualizada')).not.toBeInTheDocument();
  });

  it('sem saldo para a torna que me cabe, "Aceitar" dá lugar ao depósito do que falta', async () => {
    const user = userEvent.setup();
    wallet.mockResolvedValue(walletOf(30));
    barters.mockResolvedValue(
      page([
        barterOf({
          id: 7,
          proposerId: 3,
          receiverId: ME,
          cashPayerId: ME,
          cashDifference: 80,
          tornaStatus: 'pending',
        }),
      ]),
    );
    renderView();

    const card = await screen.findByTestId('barter-7');
    expect(
      within(card).getByText('Você paga R$ 80,00 de torna · torna reservada no aceite'),
    ).toBeVisible();
    const fund = await within(card).findByRole('button', {
      name: /^Depositar R\$\s50,00 para aceitar$/,
    });
    expect(within(card).queryByRole('button', { name: 'Aceitar' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Recusar' })).toBeEnabled();

    await user.click(fund);
    const dialog = screen.getByRole('dialog', { name: 'Depositar na carteira' });
    expect(within(dialog).getByLabelText('Valor (R$)')).toHaveValue(50);
    expect(barterAction).not.toHaveBeenCalled();
  });

  it('com saldo para a torna que me cabe, dá para aceitar direto', async () => {
    wallet.mockResolvedValue(walletOf(80));
    barters.mockResolvedValue(
      page([
        barterOf({
          id: 7,
          proposerId: 3,
          receiverId: ME,
          cashPayerId: ME,
          cashDifference: 80,
          tornaStatus: 'pending',
        }),
      ]),
    );
    renderView();

    const card = await screen.findByTestId('barter-7');
    expect(await within(card).findByRole('button', { name: 'Aceitar' })).toBeEnabled();
    expect(within(card).queryByRole('button', { name: /^Depositar/ })).not.toBeInTheDocument();
  });

  it.each([
    ['a torna é de quem propôs', { cashPayerId: 3, tornaStatus: 'pending' }],
    ['a torna que me cabe já está reservada', { cashPayerId: ME, tornaStatus: 'held' }],
  ] as const)('com pouco saldo, mas %s: dá para aceitar sem depositar', async (_n, extra) => {
    const user = userEvent.setup();
    wallet.mockResolvedValue(walletOf(10));
    barters.mockResolvedValue(
      page([barterOf({ id: 7, proposerId: 3, receiverId: ME, cashDifference: 80, ...extra })]),
    );
    renderView();

    const card = await screen.findByTestId('barter-7');
    await waitFor(() => expect(wallet).toHaveBeenCalledTimes(1));
    const accept = await within(card).findByRole('button', { name: 'Aceitar' });
    expect(within(card).queryByRole('button', { name: /^Depositar/ })).not.toBeInTheDocument();

    await user.click(accept);
    await waitFor(() => expect(barterAction).toHaveBeenCalledWith(7, 'accept'));
    expect(await screen.findByText('Troca atualizada')).toBeInTheDocument();
    await waitFor(() => expect(barters).toHaveBeenCalledTimes(2));
  });

  // Defeito de produção: useProposeBarter e useBarterAction (lib/hooks.ts) não invalidam a carteira,
  // embora a API reserve a torna ao propor/aceitar e a devolva ao recusar/cancelar. O saldo usado
  // aqui para "Falta R$ … na sua carteira" e para "Depositar … para aceitar" fica velho.
  it.todo(
    'depois de propor, aceitar, recusar ou cancelar uma troca com torna, o saldo da carteira é buscado de novo',
  );
});

describe('TrocasView: propor uma troca', () => {
  it('"Propor troca" abre o formulário e vira "Fechar"; os serviços se dividem em meus e dos outros', async () => {
    const user = userEvent.setup();
    renderView();
    const { target, submit } = await openForm(user);

    expect(screen.getByRole('heading', { level: 3, name: 'Nova proposta de troca' })).toBeVisible();
    expect(within(target).getAllByRole('option').map(plain)).toEqual([
      'Selecione um serviço…',
      'Logo profissional — R$ 300,00',
      'Consultoria de marca — a combinar',
    ]);
    expect(
      within(screen.getByLabelText('Serviço que ofereço')).getAllByRole('option').map(plain),
    ).toEqual(['Selecione…', 'Edição de vídeo', 'Aula de inglês']);
    // Sem escolher o serviço desejado não dá para enviar.
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('heading', { name: 'Nova proposta de troca' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Propor troca' })).toBeEnabled();
  });

  it('quem não tem serviço cadastrado é avisado no campo do serviço oferecido', async () => {
    const user = userEvent.setup();
    listServices.mockResolvedValue(page(SERVICES.filter((s) => s.ownerId !== ME)));
    renderView();
    await openForm(user);

    expect(
      within(screen.getByLabelText('Serviço que ofereço')).getAllByRole('option').map(plain),
    ).toEqual(['Você ainda não tem serviços']);
  });

  it('oferta de mesmo valor: diz que é equilibrada, envia o serviço oferecido e fecha o formulário', async () => {
    const user = userEvent.setup();
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '20');
    // Sem valor, ainda não há o que resumir.
    expect(screen.queryByText(/em serviço por/)).not.toBeInTheDocument();
    await user.type(value, '300');

    expect(screen.getByText('Troca equilibrada — sem torna nem taxa')).toBeVisible();
    expect(
      screen.getByText('sem taxa · você recebe R$ 300,00 em serviço por R$ 300,00'),
    ).toBeVisible();
    await user.click(submit);

    await waitFor(() => expect(proposeBarter).toHaveBeenCalledTimes(1));
    expect(proposeBarter).toHaveBeenCalledWith({
      receiverId: 2,
      requestedServiceId: 10,
      estimatedValueRequested: 300,
      estimatedValueOffered: 300,
      offeredServiceId: 20,
      offeredDescription: null,
    });
    expect(await screen.findByText('Proposta de troca enviada!')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Nova proposta de troca' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Propor troca' })).toBeEnabled();
    await waitFor(() => expect(barters).toHaveBeenCalledTimes(2));

    // Reabrir começa do zero: nem o serviço desejado nem o valor da proposta enviada ficam.
    await user.click(screen.getByRole('button', { name: 'Propor troca' }));
    expect(screen.getByLabelText('Eu quero (serviço de outro freelancer)')).toHaveValue('0');
    expect(screen.getByLabelText('Valor estimado da minha oferta (R$)')).toHaveValue(null);
    expect(screen.queryByText('Troca equilibrada — sem torna nem taxa')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar proposta' })).toBeDisabled();
  });

  it('oferta mais valiosa: o receptor paga a torna e eu recebo o líquido da taxa', async () => {
    const user = userEvent.setup();
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '20');
    await user.type(value, '400');

    expect(
      screen.getByText('Receptor te paga R$ 100,00 de torna · você recebe R$ 85,00 líquido'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'taxa R$ 15,00 sobre a torna · você recebe R$ 300,00 em serviço por R$ 400,00',
      ),
    ).toBeVisible();
    await user.click(submit);

    await waitFor(() =>
      expect(proposeBarter).toHaveBeenCalledWith({
        receiverId: 2,
        requestedServiceId: 10,
        estimatedValueRequested: 300,
        estimatedValueOffered: 400,
        offeredServiceId: 20,
        offeredDescription: null,
      }),
    );
    // Quem recebe a torna não tem nada reservado: o aviso é o simples.
    expect(await screen.findByText('Proposta de troca enviada!')).toBeInTheDocument();
  });

  it('a taxa da prévia acompanha a configuração da plataforma', async () => {
    const user = userEvent.setup();
    publicSettings.mockResolvedValue({ platformFeePercentage: 10, barterEnabled: true });
    renderView();
    await screen.findByText(/a plataforma retém 10% só sobre a torna\.$/);
    const { target, value } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.type(value, '400');

    expect(
      screen.getByText('Receptor te paga R$ 100,00 de torna · você recebe R$ 90,00 líquido'),
    ).toBeVisible();
    expect(screen.getByText(/^taxa R\$ 10,00 sobre a torna/)).toBeVisible();
  });

  it('oferta menos valiosa, com saldo: eu pago a torna, e o aviso diz quanto ficou reservado', async () => {
    const user = userEvent.setup();
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '21');
    await user.type(value, '199.5');

    expect(
      screen.getByText('Você paga R$ 100,50 de torna · reservado da sua carteira agora'),
    ).toBeVisible();
    expect(screen.queryByText(/^Falta /)).not.toBeInTheDocument();
    await user.click(submit);

    await waitFor(() =>
      expect(proposeBarter).toHaveBeenCalledWith({
        receiverId: 2,
        requestedServiceId: 10,
        estimatedValueRequested: 300,
        estimatedValueOffered: 199.5,
        offeredServiceId: 21,
        offeredDescription: null,
      }),
    );
    expect(
      await screen.findByText('Proposta de troca enviada — R$ 100,50 de torna reservados'),
    ).toBeInTheDocument();
  });

  it('"Descrever oferta" troca o serviço por um texto livre, e é ele que vai na proposta', async () => {
    const user = userEvent.setup();
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.click(screen.getByRole('button', { name: 'Descrever oferta' }));
    expect(screen.queryByLabelText('Serviço que ofereço')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('O que ofereço'), 'Edição de 3 vídeos curtos');
    await user.type(value, '300');
    await user.click(submit);

    await waitFor(() =>
      expect(proposeBarter).toHaveBeenCalledWith({
        receiverId: 2,
        requestedServiceId: 10,
        estimatedValueRequested: 300,
        estimatedValueOffered: 300,
        offeredServiceId: null,
        offeredDescription: 'Edição de 3 vídeos curtos',
      }),
    );

    // Reaberto, o texto da oferta enviada não fica; voltar para "serviço meu" devolve a lista.
    await user.click(await screen.findByRole('button', { name: 'Propor troca' }));
    expect(screen.getByLabelText('O que ofereço')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Ofereço um serviço meu' }));
    expect(screen.getByLabelText('Serviço que ofereço')).toBeInTheDocument();
    expect(screen.queryByLabelText('O que ofereço')).not.toBeInTheDocument();
  });

  it('enquanto a proposta está indo, o botão diz "Enviando…" e fica travado', async () => {
    const user = userEvent.setup();
    let release!: (b: BarterAgreement) => void;
    proposeBarter.mockReturnValue(new Promise<BarterAgreement>((resolve) => (release = resolve)));
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '20');
    await user.type(value, '300');
    await user.click(submit);

    expect(await screen.findByRole('button', { name: 'Enviando…' })).toBeDisabled();
    release(barterOf({ id: 50 }));
    expect(await screen.findByText('Proposta de troca enviada!')).toBeInTheDocument();
  });

  it('se a API recusa a proposta, mostra o motivo e o formulário continua aberto e preenchido', async () => {
    const user = userEvent.setup();
    proposeBarter.mockRejectedValueOnce(new Error('Você já propôs uma troca por este serviço.'));
    proposeBarter.mockRejectedValueOnce({ status: 500 });
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '20');
    await user.type(value, '300');
    await user.click(submit);

    expect(
      await screen.findByText('Você já propôs uma troca por este serviço.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nova proposta de troca' })).toBeVisible();
    expect(target).toHaveValue('10');
    expect(value).toHaveValue(300);

    // Falha sem mensagem: o aviso genérico.
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('Erro ao propor troca')).toBeInTheDocument();
    expect(screen.queryByText('Proposta de troca enviada!')).not.toBeInTheDocument();
  });

  it('vindo de "Propor troca" num serviço (?propor=), o formulário abre com ele escolhido e a URL é limpa', async () => {
    renderView('/trocas?propor=10');

    expect(await screen.findByRole('heading', { name: 'Nova proposta de troca' })).toBeVisible();
    const target = screen.getByLabelText('Eu quero (serviço de outro freelancer)');
    await waitFor(() => expect(target).toHaveValue('10'));
    expect(screen.getByRole('button', { name: 'Fechar' })).toBeInTheDocument();
    expect(screen.getByText('busca: vazia')).toBeInTheDocument();
  });
});

describe('TrocasView: saldo para a torna', () => {
  const pending: Deposit = {
    id: 31,
    amount: 71,
    status: 'pending',
    method: 'pix',
    gateway: 'simulated',
    reference: null,
    pixCode: '00020126PIX-31',
    expiresAt: null,
    paidAt: null,
    createdAt: '2026-09-20T15:00:00.000Z',
    canSimulate: true,
  };

  it('sem saldo para a torna: diz quanto falta, trava o envio e oferece depositar o que falta', async () => {
    const user = userEvent.setup();
    wallet.mockResolvedValue(walletOf(29.5));
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '20');
    await user.type(value, '200');

    expect(
      await screen.findByText('Falta R$ 70,50 na sua carteira para reservar a torna'),
    ).toBeVisible();
    expect(screen.getByText('Saldo R$ 29,50 · deposite via PIX sem sair daqui.')).toBeVisible();
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^Depositar R\$\s70,50$/ }));
    const dialog = screen.getByRole('dialog', { name: 'Depositar na carteira' });
    // O depósito sugerido arredonda para cima: nunca falta centavo para a torna.
    expect(within(dialog).getByLabelText('Valor (R$)')).toHaveValue(71);

    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(proposeBarter).not.toHaveBeenCalled();
  });

  it('depositar sem sair da tela: confirmado o PIX, o diálogo fecha e o envio é liberado', async () => {
    const user = userEvent.setup();
    wallet.mockResolvedValueOnce(walletOf(29.5));
    wallet.mockResolvedValue(walletOf(100.5));
    createDeposit.mockResolvedValue(pending);
    deposit.mockResolvedValue(pending);
    simulateDeposit.mockResolvedValue({ ...pending, status: 'paid', paidAt: pending.createdAt });
    renderView();
    const { target, value, submit } = await openForm(user);

    await user.selectOptions(target, '10');
    await user.selectOptions(screen.getByLabelText('Serviço que ofereço'), '20');
    await user.type(value, '200');
    await user.click(await screen.findByRole('button', { name: /^Depositar R\$\s70,50$/ }));

    const dialog = screen.getByRole('dialog', { name: 'Depositar na carteira' });
    await user.click(within(dialog).getByRole('button', { name: /^Gerar cobrança PIX de/ }));
    await waitFor(() => expect(createDeposit).toHaveBeenCalledWith({ amount: 71, method: 'pix' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Simular pagamento' }));

    await waitFor(() => expect(simulateDeposit).toHaveBeenCalledWith(31));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // O saldo novo cobre a torna: o aviso some e a proposta pode ser enviada.
    await waitFor(() => expect(screen.queryByText(/^Falta /)).not.toBeInTheDocument());
    expect(submit).toBeEnabled();
    expect(target).toHaveValue('10');
  });
});

describe('TrocasView: trocas desativadas', () => {
  beforeEach(() => {
    publicSettings.mockResolvedValue({ platformFeePercentage: 15, barterEnabled: false });
  });

  it('avisa, tira o "Propor troca" e mantém as trocas já propostas com as ações delas', async () => {
    barters.mockResolvedValue(page([barterOf({ id: 1 })]));
    renderView();

    expect(
      await screen.findByText(
        'As trocas estão desativadas no momento. Trocas já propostas seguem o fluxo normal.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propor troca' })).not.toBeInTheDocument();
    const card = await screen.findByTestId('barter-1');
    expect(within(card).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });

  it('nem o link de "propor" de um serviço abre o formulário', async () => {
    renderView('/trocas?propor=10');

    await screen.findByText(
      'As trocas estão desativadas no momento. Trocas já propostas seguem o fluxo normal.',
    );
    expect(screen.queryByRole('heading', { name: 'Nova proposta de troca' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fechar' })).not.toBeInTheDocument();
  });
});
