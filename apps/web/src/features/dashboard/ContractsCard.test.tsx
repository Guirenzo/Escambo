import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contract, ContractDeadline } from '@escambo/types';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { ContractsCard } from './ContractsCard';

/**
 * Tabela de contratações do Início: uma linha por contratação, com a modalidade e o prazo na
 * linha de apoio, o acesso à Sala e só as ações que avançam o contrato. Recusar, cancelar, pedir
 * revisão e abrir disputa ficam na Sala.
 */

const contractAction = vi.fn();
const deliverContract = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    contractAction: (id: number, action: string) => contractAction(id, action),
    deliverContract: (id: number, message: string) => deliverContract(id, message),
    requestRevision: vi.fn(),
  },
}));

const CLIENT = 1;
const FREELANCER = 2;
const auth = { user: { id: CLIENT, timezone: 'America/Sao_Paulo' } };
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const deadline = (o: Partial<ContractDeadline> = {}): ContractDeadline => ({
  state: 'none',
  noticeAt: null,
  mediationAt: null,
  extensionRequestsLeft: 2,
  undeliveredMilestones: 0,
  totalMilestones: 0,
  firstDeliveredAt: null,
  ...o,
});

const contract = (o: Partial<Contract> = {}): Contract => ({
  id: 7,
  ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  clientId: CLIENT,
  freelancerId: FREELANCER,
  serviceId: null,
  title: 'Logo para padaria',
  description: 'Logo e paleta',
  price: 200,
  platformFee: 30,
  freelancerNet: 170,
  paymentMode: 'cash',
  status: 'accepted',
  deadlineAt: null,
  createdAt: '2026-09-10T15:00:00.000Z',
  hasReview: false,
  hasMilestones: false,
  deadlineExtendedAt: null,
  overdueNotifiedAt: null,
  extension: null,
  deadline: deadline(),
  approvalDueAt: null,
  proposalExpiresAt: null,
  ...o,
});

/** Onde /contratos/:id mostra a sala que a tabela abriu. */
function SalaProbe() {
  const { id } = useParams();
  return <p>Sala da contratação {id}</p>;
}

function show(contracts: Contract[]) {
  // gcTime infinito: nem consulta nem ação deixam relógio de limpeza pendurado no fim.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ContractsCard contracts={contracts} />} />
            <Route path="/contratos/:id" element={<SalaProbe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** A linha da tabela de uma contratação, pelo título. */
const rowOf = (title: string): HTMLElement => screen.getByRole('row', { name: new RegExp(title) });
const buttonsOf = (title: string): string[] =>
  within(rowOf(title))
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '');
/** R$ com espaço normal (o Intl usa espaço não separável). */
const plain = (s: string | null): string => (s ?? '').replace(/\u00a0/g, ' ');

/**
 * A data é de mentira (o prazo é contado em dias de calendário a partir de agora), e o relógio dos
 * avisos (somem em 4 s) também, mas anda sozinho: nenhum fica pendurado no fim do teste.
 */
const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-01T15:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  contractAction.mockReset();
  contractAction.mockResolvedValue({});
  deliverContract.mockReset();
  deliverContract.mockResolvedValue({});
  auth.user = { id: CLIENT, timezone: 'America/Sao_Paulo' };
});

describe('ContractsCard', () => {
  it('a tabela tem as quatro colunas: contratação, valor, status e ações', () => {
    show([contract()]);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Contratação',
      'Valor',
      'Status',
      'Ações',
    ]);
  });

  it('lista vazia: só o cabeçalho, nenhuma linha de contratação', () => {
    show([]);
    expect(screen.getAllByRole('row')).toHaveLength(1);
  });

  it('cada linha mostra título, data de criação, modalidade, valor em R$ e o status por extenso', () => {
    show([contract({ status: 'in_progress' })]);
    const cells = within(rowOf('Logo para padaria')).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('Logo para padaria');
    expect(cells[0]).toHaveTextContent('criada em 10/09/2026 · Dinheiro');
    expect(plain(cells[1]!.textContent)).toBe('R$ 200,00');
    expect(cells[2]).toHaveTextContent(/^Em andamento$/);
  });

  it('contratação em créditos mostra o valor inteiro em "cr", sem R$', () => {
    show([contract({ paymentMode: 'credits', price: 29.6 })]);
    const cells = within(rowOf('Logo para padaria')).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent(/^30 cr$/);
    expect(cells[0]).toHaveTextContent('· Créditos');
  });

  it('troca aparece como "Troca"; modalidade e status desconhecidos aparecem como vieram', () => {
    show([
      contract({ id: 1, title: 'Aula de violão', paymentMode: 'barter' }),
      contract({
        id: 2,
        title: 'Edição de vídeo',
        paymentMode: 'pix' as Contract['paymentMode'],
        status: 'archived' as Contract['status'],
      }),
    ]);
    expect(rowOf('Aula de violão')).toHaveTextContent('· Troca');
    const cells = within(rowOf('Edição de vídeo')).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('· pix');
    expect(cells[2]).toHaveTextContent(/^archived$/);
  });

  it('prazo correndo entra na linha de apoio com quanto falta', () => {
    show([
      contract({
        deadlineAt: '2026-10-06T15:00:00.000Z',
        deadline: deadline({ state: 'running' }),
      }),
    ]);
    expect(within(rowOf('Logo para padaria')).getAllByRole('cell')[0]).toHaveTextContent(
      'criada em 10/09/2026 · Dinheiro · faltam 5 dias',
    );
  });

  it('prazo vencido e pedido de extensão também aparecem', () => {
    show([
      contract({ id: 1, title: 'Aula de violão', deadline: deadline({ state: 'grace' }) }),
      contract({ id: 2, title: 'Edição de vídeo', deadline: deadline({ state: 'paused' }) }),
      contract({ id: 3, title: 'Cartão de visita', deadline: deadline({ state: 'due' }) }),
    ]);
    expect(rowOf('Aula de violão')).toHaveTextContent('· Dinheiro · vencido');
    expect(rowOf('Edição de vídeo')).toHaveTextContent('· Dinheiro · extensão pedida');
    expect(rowOf('Cartão de visita')).toHaveTextContent('· Dinheiro · venceu');
  });

  it('prazo já cumprido (houve entrega) e contratação sem prazo não mostram nada de prazo', () => {
    show([
      contract({ id: 1, title: 'Aula de violão', deadline: deadline({ state: 'met' }) }),
      contract({ id: 2, title: 'Edição de vídeo', deadline: deadline({ state: 'none' }) }),
    ]);
    for (const title of ['Aula de violão', 'Edição de vídeo']) {
      const cell = within(rowOf(title)).getAllByRole('cell')[0]!;
      expect(cell.textContent).toMatch(/criada em 10\/09\/2026 · Dinheiro$/);
    }
    expect(screen.queryByText('entregue')).not.toBeInTheDocument();
  });

  it('Sala abre a sala da contratação daquela linha', async () => {
    const user = setup();
    show([contract({ id: 7 }), contract({ id: 12, title: 'Aula de violão' })]);
    await user.click(within(rowOf('Aula de violão')).getByRole('button', { name: 'Sala' }));
    expect(screen.getByText('Sala da contratação 12')).toBeInTheDocument();
  });

  it('na tabela os botões são os compactos', () => {
    show([contract({ status: 'delivered' })]);
    expect(screen.getByRole('button', { name: 'Sala' })).toHaveClass('mini');
    expect(screen.getByRole('button', { name: 'Aprovar entrega' })).toHaveClass('mini');
  });

  it('cliente com contratação aceita: só a Sala (cancelar e disputa ficam lá)', () => {
    show([contract({ status: 'accepted' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Sala']);
  });

  it('cliente com entrega feita: aprova pela tabela; pedir revisão e disputa ficam na Sala', async () => {
    const user = setup();
    show([contract({ status: 'delivered' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Sala', 'Aprovar entrega']);
    await user.click(screen.getByRole('button', { name: 'Aprovar entrega' }));
    expect(contractAction).toHaveBeenCalledWith(7, 'approve');
    expect(
      await screen.findByText('Entrega aprovada. Valor liberado para o freelancer.'),
    ).toBeInTheDocument();
  });

  it('freelancer com proposta pendente: aceita pela tabela; recusar fica na Sala', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    show([contract({ status: 'pending' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Sala', 'Aceitar']);
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(contractAction).toHaveBeenCalledWith(7, 'accept');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
  });

  it('API recusa o aceite: mostra a mensagem dela e a linha continua lá', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    contractAction.mockRejectedValue(new Error('A proposta expirou.'));
    show([contract({ status: 'pending' })]);
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(await screen.findByText('A proposta expirou.')).toBeInTheDocument();
    expect(screen.queryByText('Contratação atualizada')).not.toBeInTheDocument();
    expect(rowOf('Logo para padaria')).toBeInTheDocument();
  });

  it('freelancer em andamento: registra a entrega com a mensagem digitada; desistir e disputa ficam na Sala', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  Arquivos na pasta  ');
    show([contract({ status: 'in_progress' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Sala', 'Registrar entrega']);
    await user.click(screen.getByRole('button', { name: 'Registrar entrega' }));
    expect(prompt).toHaveBeenCalledWith('Mensagem da entrega (o que foi feito, onde está):');
    expect(deliverContract).toHaveBeenCalledTimes(1);
    expect(deliverContract).toHaveBeenCalledWith(7, 'Arquivos na pasta');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
  });

  it('entrega sem mensagem (prompt cancelado) não chama a API', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    show([contract({ status: 'in_progress' })]);
    await user.click(screen.getByRole('button', { name: 'Registrar entrega' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(deliverContract).not.toHaveBeenCalled();
    expect(screen.queryByText('Contratação atualizada')).not.toBeInTheDocument();
  });

  it('cliente com contratação concluída sem avaliação: Avaliar leva para a Sala', async () => {
    const user = setup();
    show([contract({ id: 31, status: 'completed' })]);
    await user.click(screen.getByRole('button', { name: 'Avaliar' }));
    expect(screen.getByText('Sala da contratação 31')).toBeInTheDocument();
    expect(contractAction).not.toHaveBeenCalled();
  });

  it('quem não é parte da contratação só tem a Sala', () => {
    auth.user = { id: 99, timezone: 'America/Sao_Paulo' };
    show([contract({ status: 'delivered' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Sala']);
  });
});
