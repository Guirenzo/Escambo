import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contract, ContractDeadline } from '@escambo/types';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { ContractsCard } from './ContractsCard';

/**
 * Contratações do Início em cartões (como uma agenda): o bloco de data, valor, modalidade e etapa,
 * o prazo quando ele cobra, o botão largo para a Sala e só as ações que avançam o contrato.
 * Recusar, cancelar, pedir revisão e abrir disputa ficam na Sala.
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
  deadlineZone: 'America/Sao_Paulo',
  revisionRequestedAt: null,
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

/** Onde /contratos/:id mostra a sala que o cartão abriu. */
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

/** O cartão de uma contratação, pelo título (o artigo leva o título como nome). */
const cardOf = (title: string): HTMLElement => screen.getByRole('article', { name: title });
const buttonsOf = (title: string): string[] =>
  within(cardOf(title))
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '');
/** R$ com espaço normal (o Intl usa espaço não separável). */
const plain = (s: string | null): string => (s ?? '').replace(/\u00a0/g, ' ');
/** O valor de um item da lista de definições do cartão ("Valor", "Pagamento"). */
const meta = (title: string, label: string): string =>
  plain(within(cardOf(title)).getByText(label).nextElementSibling?.textContent ?? null);

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
  it('é uma lista de contratações: um artigo por contratação, com o título como nome', () => {
    show([contract({ id: 1, title: 'Logo' }), contract({ id: 2, title: 'Aula de violão' })]);
    const list = screen.getByRole('list', { name: 'Contratações' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(list)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-labelledby')),
    ).toEqual(['deal-1', 'deal-2']);
    expect(screen.getByRole('heading', { level: 3, name: 'Aula de violão' })).toBeInTheDocument();
  });

  it('proposta de empresa (RF-018): quem entrega vê o nome fantasia, com o link e o selo; o cliente não se vê', () => {
    const company = { ulid: '01EMPRESA', tradeName: 'Pão Bom' };
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    show([
      contract({ id: 1, title: 'Logo', clientCompany: company }),
      contract({ id: 2, title: 'Aula' }),
    ]);
    const tag = within(cardOf('Logo')).getByTestId('company-tag');
    expect(tag).toHaveTextContent('Contratante: Pão Bom Empresa');
    expect(within(tag).getByRole('link', { name: 'Pão Bom' })).toHaveAttribute(
      'href',
      '/empresas/01EMPRESA',
    );
    expect(within(cardOf('Aula')).queryByTestId('company-tag')).not.toBeInTheDocument();
  });

  it('a própria empresa não vê o selo de si mesma nos cartões', () => {
    show([
      contract({
        id: 1,
        title: 'Logo',
        clientCompany: { ulid: '01EMPRESA', tradeName: 'Pão Bom' },
      }),
    ]);
    expect(screen.queryByTestId('company-tag')).not.toBeInTheDocument();
  });

  it('lista vazia: a lista sem nenhum cartão', () => {
    show([]);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('no caminho da contratação, o cartão mostra a etapa de 1 a 4; fora dele, nenhuma', () => {
    show([
      contract({ id: 1, title: 'Proposta', status: 'pending' }),
      contract({ id: 2, title: 'Aceita', status: 'accepted' }),
      contract({ id: 3, title: 'Revisão', status: 'revision_requested' }),
      contract({ id: 4, title: 'Entregue', status: 'delivered' }),
      contract({ id: 5, title: 'Concluída', status: 'completed' }),
      contract({ id: 6, title: 'Cancelada', status: 'cancelled' }),
    ]);
    const stage = (title: string) =>
      within(cardOf(title)).queryByText(/^Etapa \d de 4$/)?.textContent;
    expect(['Proposta', 'Aceita', 'Revisão', 'Entregue', 'Concluída'].map(stage)).toEqual([
      'Etapa 1 de 4',
      'Etapa 2 de 4',
      'Etapa 2 de 4',
      'Etapa 3 de 4',
      'Etapa 4 de 4',
    ]);
    expect(stage('Cancelada')).toBeUndefined();
    // Os traços acesos são os da etapa (decorativos: o texto ao lado é que diz a etapa).
    expect(cardOf('Entregue').querySelectorAll('.stage-dot.on')).toHaveLength(3);
    expect(cardOf('Entregue').querySelector('.stage')).toHaveAttribute('aria-hidden', 'true');
  });

  it('cada cartão mostra o título, o status por extenso, o valor em R$ e a modalidade', () => {
    show([contract({ status: 'in_progress' })]);
    const card = cardOf('Logo para padaria');
    expect(within(card).getByText('Em andamento')).toHaveClass('pill', 'status-in_progress');
    expect(meta('Logo para padaria', 'Valor')).toBe('R$ 200,00');
    expect(meta('Logo para padaria', 'Pagamento')).toBe('Dinheiro');
  });

  it('sem prazo, o bloco de data é o dia da criação: mês curto e dia grande, e a data por extenso para o leitor', () => {
    show([contract()]);
    const block = cardOf('Logo para padaria').querySelector('.deal-date')!;
    expect(block).not.toHaveClass('is-deadline');
    expect(within(block as HTMLElement).getByText('Criada')).toBeInTheDocument();
    expect(block.querySelector('.deal-date-month')).toHaveTextContent('set');
    expect(block.querySelector('.deal-date-day')).toHaveTextContent('10');
    expect(block.querySelector('.deal-date-month')).toHaveAttribute('aria-hidden', 'true');
    expect(within(block as HTMLElement).getByText('10 de setembro')).toHaveClass('sr-only');
  });

  it('com prazo, o bloco mostra o dia do prazo no fuso dele (ADR 58)', () => {
    // 23:59:59 de 05/11 em Manaus já é 06/11 em Brasília: o dia que vale é o do fuso do prazo.
    show([
      contract({
        deadlineAt: '2026-11-06T03:59:59.000Z',
        deadlineZone: 'America/Manaus',
        deadline: deadline({ state: 'running' }),
      }),
    ]);
    const block = cardOf('Logo para padaria').querySelector('.deal-date') as HTMLElement;
    expect(block).toHaveClass('is-deadline');
    expect(within(block).getByText('Prazo')).toBeInTheDocument();
    expect(within(block).getByText('5 de novembro')).toBeInTheDocument();
    expect(block.querySelector('.deal-date-day')).toHaveTextContent('05');
  });

  it('contratação em créditos mostra o valor inteiro em "cr", sem R$', () => {
    show([contract({ paymentMode: 'credits', price: 29.6 })]);
    expect(meta('Logo para padaria', 'Valor')).toBe('30 cr');
    expect(meta('Logo para padaria', 'Pagamento')).toBe('Créditos');
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
    expect(meta('Aula de violão', 'Pagamento')).toBe('Troca');
    expect(meta('Edição de vídeo', 'Pagamento')).toBe('pix');
    expect(within(cardOf('Edição de vídeo')).getByText('archived')).toHaveClass('pill');
  });

  it('prazo correndo aparece no cartão com quanto falta', () => {
    show([
      contract({
        deadlineAt: '2026-10-06T15:00:00.000Z',
        deadline: deadline({ state: 'running' }),
      }),
    ]);
    expect(within(cardOf('Logo para padaria')).getByText('faltam 5 dias')).toHaveClass(
      'deal-deadline',
    );
  });

  it('prazo vencido e pedido de extensão também aparecem', () => {
    show([
      contract({ id: 1, title: 'Aula de violão', deadline: deadline({ state: 'grace' }) }),
      contract({ id: 2, title: 'Edição de vídeo', deadline: deadline({ state: 'paused' }) }),
      contract({ id: 3, title: 'Cartão de visita', deadline: deadline({ state: 'due' }) }),
    ]);
    expect(within(cardOf('Aula de violão')).getByText('vencido')).toHaveClass('deadline-text-late');
    expect(within(cardOf('Edição de vídeo')).getByText('extensão pedida')).toHaveClass(
      'deadline-text-paused',
    );
    expect(within(cardOf('Cartão de visita')).getByText('venceu')).toBeInTheDocument();
  });

  it('prazo já cumprido (houve entrega) e contratação sem prazo não mostram nada de prazo', () => {
    show([
      contract({ id: 1, title: 'Aula de violão', deadline: deadline({ state: 'met' }) }),
      contract({ id: 2, title: 'Edição de vídeo', deadline: deadline({ state: 'none' }) }),
    ]);
    for (const title of ['Aula de violão', 'Edição de vídeo'])
      expect(cardOf(title).querySelector('.deal-deadline')).toBeNull();
    expect(screen.queryByText('entregue')).not.toBeInTheDocument();
  });

  it('"Abrir sala" abre a sala da contratação daquele cartão', async () => {
    const user = setup();
    show([contract({ id: 7 }), contract({ id: 12, title: 'Aula de violão' })]);
    await user.click(within(cardOf('Aula de violão')).getByRole('button', { name: 'Abrir sala' }));
    expect(screen.getByText('Sala da contratação 12')).toBeInTheDocument();
  });

  it('no cartão os botões têm o tamanho normal: a ação que avança o contrato em destaque', () => {
    show([contract({ status: 'delivered' })]);
    expect(screen.getByRole('button', { name: 'Abrir sala' })).toHaveClass('deal-open');
    expect(screen.getByRole('button', { name: 'Aprovar entrega' })).not.toHaveClass('mini');
  });

  it('cliente com contratação aceita: só a Sala (cancelar e disputa ficam lá)', () => {
    show([contract({ status: 'accepted' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Abrir sala']);
  });

  it('cliente com entrega feita: aprova pelo cartão; pedir revisão e disputa ficam na Sala', async () => {
    const user = setup();
    show([contract({ status: 'delivered' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Abrir sala', 'Aprovar entrega']);
    await user.click(screen.getByRole('button', { name: 'Aprovar entrega' }));
    expect(contractAction).toHaveBeenCalledWith(7, 'approve');
    expect(
      await screen.findByText('Entrega aprovada. Valor liberado para o freelancer.'),
    ).toBeInTheDocument();
  });

  it('freelancer com proposta pendente: aceita pelo cartão; recusar fica na Sala', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    show([contract({ status: 'pending' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Abrir sala', 'Aceitar']);
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(contractAction).toHaveBeenCalledWith(7, 'accept');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
  });

  it('API recusa o aceite: mostra a mensagem dela e o cartão continua lá', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    contractAction.mockRejectedValue(new Error('A proposta expirou.'));
    show([contract({ status: 'pending' })]);
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(await screen.findByText('A proposta expirou.')).toBeInTheDocument();
    expect(screen.queryByText('Contratação atualizada')).not.toBeInTheDocument();
    expect(cardOf('Logo para padaria')).toBeInTheDocument();
  });

  it('freelancer em andamento: registra a entrega com a mensagem digitada; desistir e disputa ficam na Sala', async () => {
    const user = setup();
    auth.user = { id: FREELANCER, timezone: 'America/Sao_Paulo' };
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  Arquivos na pasta  ');
    show([contract({ status: 'in_progress' })]);
    expect(buttonsOf('Logo para padaria')).toEqual(['Abrir sala', 'Registrar entrega']);
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
    expect(buttonsOf('Logo para padaria')).toEqual(['Abrir sala']);
  });
});
