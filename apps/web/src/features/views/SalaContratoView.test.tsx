import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CancelTerms,
  ChatAttachment,
  ChatHistory,
  ChatMessage,
  ContractWithHistory,
  Dispute,
  Milestone,
  Review,
} from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { SalaContratoView } from './SalaContratoView';

/**
 * Sala da contratação: valores e linha do tempo, os avisos de até quando cada lado age (ADR 57),
 * o chat em tempo real com anexos, a avaliação depois de concluída e as ações do contrato.
 */

// Tela inteira com modais: com a suíte toda em paralelo, 5 s ficam curtos.
vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  contractDetail: vi.fn(),
  chatHistory: vi.fn(),
  sendMessage: vi.fn(),
  sendAttachment: vi.fn(),
  attachmentBlob: vi.fn(),
  createReview: vi.fn(),
  respondReview: vi.fn(),
  disputes: vi.fn(),
  openDispute: vi.fn(),
  contractAction: vi.fn(),
  publicSettings: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

const auth = vi.hoisted(() => ({
  user: { id: 1, timezone: 'America/Sao_Paulo' as string | null },
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

type Listener = (payload?: unknown) => void;
/** Socket de mentira: guarda quem está ouvindo cada evento e deixa o teste disparar um. */
const socket = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    connected: false,
    listeners,
    emit: vi.fn(),
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
    },
    fire(event: string, payload?: unknown) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
  };
});
vi.mock('../../lib/socket', () => ({ getSocket: () => socket }));

const CLIENT = 1;
const FREELANCER = 2;
const ID = 9;
const CREATED = '2026-09-28T13:00:00.000Z';

const contract = (o: Partial<ContractWithHistory> = {}): ContractWithHistory => ({
  id: ID,
  ulid: 'c-9',
  clientId: CLIENT,
  freelancerId: FREELANCER,
  serviceId: 21,
  title: 'Vídeo institucional',
  description: 'Vídeo de 1 minuto.',
  price: 200,
  platformFee: 30,
  freelancerNet: 170,
  paymentMode: 'cash',
  status: 'accepted',
  deadlineAt: null,
  deadlineZone: 'America/Sao_Paulo',
  revisionRequestedAt: null,
  createdAt: CREATED,
  hasReview: false,
  hasMilestones: false,
  deadlineExtendedAt: null,
  overdueNotifiedAt: null,
  extension: null,
  deadline: {
    state: 'none',
    noticeAt: null,
    mediationAt: null,
    extensionRequestsLeft: 0,
    undeliveredMilestones: 0,
    totalMilestones: 0,
    firstDeliveredAt: null,
  },
  approvalDueAt: null,
  proposalExpiresAt: null,
  history: [
    { previousStatus: null, status: 'pending', note: 'Proposta enviada', at: CREATED },
    { previousStatus: 'pending', status: 'accepted', note: null, at: '2026-09-29T09:00:00.000Z' },
  ],
  milestones: [],
  review: null,
  cancellation: null,
  ...o,
});

const message = (o: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  conversationId: 5,
  senderId: FREELANCER,
  type: 'text',
  content: 'Olá!',
  attachment: null,
  createdAt: '2026-10-01T14:00:00.000Z',
  removedAt: null,
  signals: [],
  ...o,
});

const history = (messages: ChatMessage[]): ChatHistory => ({
  conversationId: 5,
  contractId: ID,
  otherPartyId: FREELANCER,
  messages,
});

const attachment = (o: Partial<ChatAttachment> = {}): ChatAttachment => ({
  name: 'briefing.pdf',
  mime: 'application/pdf',
  size: 2048,
  url: '/api/messaging/attachments/77',
  purgedAt: null,
  purgedReason: null,
  ...o,
});

const review = (o: Partial<Review> = {}): Review => ({
  id: 55,
  contractId: ID,
  reviewerId: CLIENT,
  revieweeId: FREELANCER,
  rating: 4,
  comment: 'Ficou ótimo.',
  response: null,
  createdAt: '2026-09-30T18:00:00.000Z',
  removedAt: null,
  ...o,
});

const pdf = (name = 'roteiro.pdf'): File => new File(['%PDF'], name, { type: 'application/pdf' });

/** Texto de um elemento como a pessoa lê: espaço normal no R$ e sem quebras. */
const read = (el: Element | null): string =>
  (el?.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const card = (heading: string): HTMLElement =>
  screen.getByRole('heading', { name: heading }).closest('section')!;
const draftInput = (): HTMLElement =>
  screen.getByPlaceholderText(/^(Escreva uma mensagem…|Legenda \(opcional\)…)$/);
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Enviar' });

function renderSala(
  as: number = CLIENT,
  onBack: () => void = () => undefined,
  timezone: string | null = 'America/Sao_Paulo',
) {
  auth.user = { id: as, timezone };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <SalaContratoView contractId={ID} onBack={onBack} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Renderiza e espera a contratação e o histórico do chat chegarem. */
async function openSala(as: number = CLIENT, timezone: string | null = 'America/Sao_Paulo') {
  const view = renderSala(as, undefined, timezone);
  await screen.findByRole('heading', { level: 1, name: 'Vídeo institucional' });
  await waitFor(() => expect(within(card('Chat')).queryByText('Carregando…')).toBeNull());
  return view;
}

const scrollIntoView = vi.fn();

beforeAll(() => {
  // O jsdom não rola a tela: a Sala pede para rolar o chat até a última mensagem.
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  socket.emit.mockReset();
  socket.listeners.clear();
  socket.connected = false;
  scrollIntoView.mockClear();
  api.contractDetail.mockResolvedValue(contract());
  api.chatHistory.mockResolvedValue(history([]));
  api.disputes.mockResolvedValue([]);
  api.publicSettings.mockResolvedValue({ extensionResponseHours: 48 });
});

describe('SalaContratoView: carregamento', () => {
  it('enquanto carrega, o título é o número do contrato e o chat diz "Carregando…"', () => {
    api.contractDetail.mockReturnValue(new Promise(() => undefined));
    api.chatHistory.mockReturnValue(new Promise(() => undefined));
    renderSala();
    expect(screen.getByRole('heading', { level: 1, name: 'Contrato #9' })).toBeVisible();
    expect(
      within(card('Linha do tempo')).getByRole('status', { name: 'Carregando' }),
    ).toBeVisible();
    expect(within(card('Chat')).getByText('Carregando…')).toBeVisible();
    expect(api.contractDetail).toHaveBeenCalledWith(ID);
    expect(api.chatHistory).toHaveBeenCalledWith(ID);
    expect(document.title).toBe('Contratação · Escambo');
  });

  it('contratação que a API recusa: mostra o erro e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockRejectedValueOnce(new Error('Contratação não encontrada'));
    renderSala();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Contratação não encontrada');
    expect(screen.getByRole('heading', { level: 1, name: 'Contrato #9' })).toBeVisible();

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vídeo institucional' }),
    ).toBeVisible();
    expect(api.contractDetail).toHaveBeenCalledTimes(2);
  });

  it('"Voltar" chama quem abriu a Sala', async () => {
    const user = userEvent.setup({ delay: null });
    const onBack = vi.fn();
    renderSala(CLIENT, onBack);
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('SalaContratoView: valores e linha do tempo', () => {
  it('em dinheiro: valor, taxa, líquido, onde o dinheiro está e a linha do tempo com as notas', async () => {
    api.contractDetail.mockResolvedValue(contract({ status: 'delivered' }));
    await openSala();
    expect(screen.getByText(`Dinheiro · criado em ${dtm(CREATED)}`)).toBeInTheDocument();
    // O status atual no topo (a linha do tempo deste exemplo ainda não tem "Entregue").
    expect(screen.getByText('Entregue')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Vídeo institucional · Escambo'));

    const timeline = within(card('Linha do tempo'));
    // Rótulo e valor, par a par, como estão na tela.
    expect(read(timeline.getByText('Valor').parentElement)).toBe(
      [
        'Valor',
        'R$ 200,00',
        'Taxa',
        'R$ 30,00',
        'Líquido',
        'R$ 170,00',
        'Pagamento',
        'Valor em escrow · liberado na aprovação',
        'Prazo',
        'sem prazo definido',
      ].join(''),
    );
    const steps = timeline.getAllByRole('listitem').map(read);
    expect(steps).toEqual([
      `PendenteProposta enviada${dtm(CREATED)}`,
      `Aceito · de Pendente${dtm('2026-09-29T09:00:00.000Z')}`,
    ]);
  });

  it('passo da linha do tempo que não muda o status (ex.: prazo estendido) não diz "de"', async () => {
    api.contractDetail.mockResolvedValue(
      contract({
        history: [
          {
            previousStatus: 'accepted',
            status: 'accepted',
            note: 'Prazo estendido',
            at: '2026-09-30T09:00:00.000Z',
          },
        ],
      }),
    );
    await openSala();
    const steps = within(card('Linha do tempo')).getAllByRole('listitem').map(read);
    expect(steps).toEqual([`AceitoPrazo estendido${dtm('2026-09-30T09:00:00.000Z')}`]);
  });

  it('em troca, o topo diz "Troca"', async () => {
    api.contractDetail.mockResolvedValue(contract({ paymentMode: 'barter' }));
    await openSala();
    expect(screen.getByText(`Troca · criado em ${dtm(CREATED)}`)).toBeInTheDocument();
  });

  it('em créditos: valores em créditos inteiros e sem taxa', async () => {
    api.contractDetail.mockResolvedValue(
      contract({ paymentMode: 'credits', price: 30, platformFee: 0, freelancerNet: 30 }),
    );
    await openSala();
    expect(screen.getByText(`Créditos Escambo · criado em ${dtm(CREATED)}`)).toBeInTheDocument();
    const kv = within(card('Linha do tempo')).getByText('Valor').parentElement;
    expect(read(kv)).toContain('Valor30 créditosTaxasem taxaLíquido30 créditos');
  });

  it('com prazo, a linha do tempo diz o dia e "até 23:59", e a seção de prazo aparece com o mesmo dia', async () => {
    const deadlineAt = '2026-12-20T02:59:59.000Z'; // sáb 19/12, 23:59:59 em Brasília
    api.contractDetail.mockResolvedValue(
      contract({
        deadlineAt,
        deadline: { ...contract().deadline, state: 'running', extensionRequestsLeft: 2 },
      }),
    );
    await openSala();
    expect(screen.getByTestId('deadline-kv').textContent).toBe('sáb, 19/12/2026, até 23:59');
    expect(within(card('Prazo de entrega')).getByTestId('deadline-date').textContent).toBe(
      'sáb, 19/12/2026, até 23:59',
    );
  });

  it.each<[string, string | null, string]>([
    ['Brasília', 'America/Sao_Paulo', 'sáb, 19/12/2026, até 23:59 (horário de Manaus)'],
    ['sem fuso escolhido (Brasília)', null, 'sáb, 19/12/2026, até 23:59 (horário de Manaus)'],
    ['Cuiabá (mesmo relógio de Manaus)', 'America/Cuiaba', 'sáb, 19/12/2026, até 23:59'],
    ['Manaus', 'America/Manaus', 'sáb, 19/12/2026, até 23:59'],
  ])(
    'prazo de Manaus lido de %s: o mesmo dia, com a nota só em outro relógio',
    async (_n, tz, kv) => {
      api.contractDetail.mockResolvedValue(
        contract({
          deadlineAt: '2026-12-20T03:59:59.000Z', // sáb 19/12, 23:59:59 em Manaus
          deadlineZone: 'America/Manaus',
          deadline: { ...contract().deadline, state: 'running', extensionRequestsLeft: 2 },
        }),
      );
      await openSala(CLIENT, tz);
      expect(screen.getByTestId('deadline-kv').textContent).toBe(kv);
    },
  );

  it('prazo sem o fuso (API antiga, durante o deploy) vale em Brasília, também para quem lê em Manaus', async () => {
    const c = contract({
      deadlineAt: '2026-12-20T02:59:59.000Z', // sáb 19/12, 23:59:59 em Brasília
      deadline: { ...contract().deadline, state: 'running', extensionRequestsLeft: 2 },
    });
    delete (c as Partial<ContractWithHistory>).deadlineZone;
    api.contractDetail.mockResolvedValue(c);
    await openSala(CLIENT, 'America/Manaus');
    expect(screen.getByTestId('deadline-kv').textContent).toBe(
      'sáb, 19/12/2026, até 23:59 (horário de Brasília)',
    );
  });

  /**
   * Revisão em aberto (ADR 58, RN-081): sem prazo (troca, ou criada sem data) a seção do prazo some,
   * mas a Sala diz desde quando a revisão foi pedida, para as duas partes; com prazo, a mesma linha
   * fica dentro da seção do prazo, uma vez só.
   */
  describe('revisão pedida', () => {
    // Agora: qui, 01/10/2026, meio-dia em Brasília; a revisão foi pedida há 10 dias.
    beforeAll(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T15:00:00Z'));
    });
    afterAll(() => vi.useRealTimers());

    const inRevision = (o: Partial<ContractWithHistory> = {}) =>
      contract({
        status: 'revision_requested',
        revisionRequestedAt: '2026-09-21T13:00:00.000Z', // seg 21/09, 10:00 em Brasília
        ...o,
      });
    const CLIENT_TEXT =
      'Revisão pedida em seg, 21/09, às 10:00, há 10 dias, sem nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.';
    const FREELANCER_TEXT =
      'Revisão pedida em seg, 21/09, às 10:00, há 10 dias: registre a nova entrega. O cliente pode abrir uma disputa a qualquer momento.';

    it.each<[string, number, string]>([
      ['o cliente', CLIENT, CLIENT_TEXT],
      ['o freelancer', FREELANCER, FREELANCER_TEXT],
    ])(
      'troca sem prazo em revisão: %s lê na Sala desde quando a revisão foi pedida',
      async (_n, me, text) => {
        api.contractDetail.mockResolvedValue(inRevision({ paymentMode: 'barter' }));
        await openSala(me);
        expect(screen.queryByRole('heading', { name: 'Prazo de entrega' })).toBeNull();
        expect(screen.getAllByTestId('revision-since')).toHaveLength(1);
        expect(within(card('Revisão pedida')).getByTestId('revision-since').textContent).toBe(text);
      },
    );

    it('com prazo, a linha aparece uma vez só, dentro da seção do prazo', async () => {
      api.contractDetail.mockResolvedValue(
        inRevision({
          deadlineAt: '2026-09-26T02:59:59.000Z', // sex 25/09, 23:59:59 em Brasília
          deadline: {
            ...contract().deadline,
            state: 'met',
            firstDeliveredAt: '2026-09-20T12:00:00.000Z',
          },
        }),
      );
      await openSala(CLIENT);
      expect(screen.getAllByTestId('revision-since')).toHaveLength(1);
      expect(within(card('Prazo de entrega')).getByTestId('revision-since').textContent).toBe(
        CLIENT_TEXT,
      );
      expect(screen.queryByTestId('revision')).toBeNull();
    });
  });

  it('sem prazo, a seção de prazo não aparece; com marcos, a de marcos aparece', async () => {
    const milestone = (id: number, title: string): Milestone => ({
      id,
      title,
      description: null,
      amount: 100,
      freelancerNet: 85,
      sortOrder: id,
      status: 'funded',
      dueAt: null,
      deliveredAt: null,
      deliveryNote: null,
      revisionNote: null,
      releasedAt: null,
      approvalDueAt: null,
      dueZone: 'America/Sao_Paulo',
      revisionRequestedAt: null,
    });
    api.contractDetail.mockResolvedValue(
      contract({
        hasMilestones: true,
        milestones: [milestone(1, 'Roteiro'), milestone(2, 'Edição')],
      }),
    );
    await openSala();
    expect(screen.queryByRole('heading', { name: 'Prazo de entrega' })).toBeNull();
    const milestones = within(card('Marcos'));
    expect(milestones.getByText('Roteiro')).toBeInTheDocument();
    expect(milestones.getByText('Edição')).toBeInTheDocument();
    expect(
      within(card('Linha do tempo')).getByText('Em escrow · liberado marco a marco'),
    ).toBeVisible();
  });

  it.each([
    ['barter', 'accepted', 'Troca de serviços · sem escrow'],
    ['cash', 'pending', 'Reservado na carteira do cliente'],
    ['credits', 'pending', 'Créditos retidos no aceite'],
    ['cash', 'in_progress', 'Valor em escrow · liberado na aprovação'],
    ['cash', 'revision_requested', 'Valor em escrow · liberado na aprovação'],
    ['cash', 'completed', 'Valor liberado ao freelancer'],
    ['cash', 'rejected', 'Valor devolvido ao cliente'],
    ['cash', 'cancelled', 'Valor liquidado pela política de reembolso'],
    ['cash', 'disputed', 'Congelado até a decisão da mediação'],
  ] as const)('pagamento em %s com status %s: "%s"', async (paymentMode, status, expected) => {
    api.contractDetail.mockResolvedValue(contract({ paymentMode, status }));
    await openSala();
    expect(within(card('Linha do tempo')).getByText(expected)).toBeInTheDocument();
  });

  it('por marcos em créditos, diz que os créditos saem marco a marco', async () => {
    api.contractDetail.mockResolvedValue(
      contract({ paymentMode: 'credits', status: 'in_progress', hasMilestones: true }),
    );
    await openSala();
    expect(
      within(card('Linha do tempo')).getByText('Créditos em escrow · liberados marco a marco'),
    ).toBeInTheDocument();
  });
});

describe('SalaContratoView: até quando cada lado age', () => {
  // O relógio fica antes das horas dos exemplos, como na seção de prazo.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T15:00:00Z'));
  });
  afterAll(() => vi.useRealTimers());

  const delivered = (o: Partial<ContractWithHistory> = {}) =>
    contract({ status: 'delivered', approvalDueAt: '2026-10-03T12:00:00.000Z', ...o });
  const proposal = (o: Partial<ContractWithHistory> = {}) =>
    contract({
      status: 'pending',
      proposalExpiresAt: '2026-10-02T12:00:00.000Z',
      deadlineAt: '2026-10-05T18:00:00.000Z',
      deadline: { ...contract().deadline, state: 'proposal' },
      ...o,
    });
  const notice = (start: RegExp): string => read(screen.getByText(start));

  it('entrega registrada: o cliente lê até quando aprovar e o que acontece depois', async () => {
    api.contractDetail.mockResolvedValue(delivered());
    await openSala(CLIENT);
    expect(notice(/Entrega registrada\./)).toBe(
      'Entrega registrada. Aprove, peça revisão ou abra disputa até sáb, 03/10, às 09:00; depois disso a entrega é aprovada automaticamente e o pagamento é liberado ao freelancer.',
    );
  });

  it('entrega registrada: o freelancer lê quanto recebe se o cliente não responder', async () => {
    api.contractDetail.mockResolvedValue(delivered());
    await openSala(FREELANCER);
    expect(notice(/Entrega registrada\./)).toBe(
      'Entrega registrada. Sem resposta do cliente até sáb, 03/10, às 09:00, ela é aprovada automaticamente e R$ 170,00 é liberado para você.',
    );
  });

  it('entrega em créditos: o freelancer lê o líquido em créditos', async () => {
    api.contractDetail.mockResolvedValue(
      delivered({ paymentMode: 'credits', price: 30, freelancerNet: 30 }),
    );
    await openSala(FREELANCER);
    expect(notice(/Entrega registrada\./)).toMatch(
      /aprovada automaticamente e 30 créditos é liberado para você\.$/,
    );
  });

  it('entrega de uma troca: não fala em pagamento para nenhum dos lados', async () => {
    api.contractDetail.mockResolvedValue(delivered({ paymentMode: 'barter' }));
    const { unmount } = await openSala(CLIENT);
    expect(notice(/Entrega registrada\./)).toMatch(
      /a entrega é aprovada automaticamente e conta para fechar a troca\.$/,
    );
    unmount();
    await openSala(FREELANCER);
    expect(notice(/Entrega registrada\./)).toBe(
      'Entrega registrada. Sem resposta do cliente até sáb, 03/10, às 09:00, ela é aprovada automaticamente.',
    );
  });

  it('proposta: o freelancer lê até quando responder e quanto tempo terá até o prazo', async () => {
    api.contractDetail.mockResolvedValue(proposal());
    await openSala(FREELANCER);
    expect(notice(/Responda até/)).toBe(
      'Responda até sex, 02/10, às 09:00: aceite ou recuse. Se aceitar agora, você terá 4 dias e 3 h até o prazo.',
    );
  });

  it('proposta sem prazo de entrega: o aviso ao freelancer para no "aceite ou recuse"', async () => {
    api.contractDetail.mockResolvedValue(proposal({ deadlineAt: null }));
    await openSala(FREELANCER);
    expect(notice(/Responda até/)).toBe('Responda até sex, 02/10, às 09:00: aceite ou recuse.');
  });

  it('proposta com o prazo de entrega já vencido: não promete tempo até o prazo', async () => {
    api.contractDetail.mockResolvedValue(proposal({ deadlineAt: '2026-10-01T14:00:00.000Z' }));
    await openSala(FREELANCER);
    expect(notice(/Responda até/)).toBe('Responda até sex, 02/10, às 09:00: aceite ou recuse.');
  });

  it('proposta: o cliente lê que o valor reservado volta se o freelancer não responder', async () => {
    api.contractDetail.mockResolvedValue(proposal());
    await openSala(CLIENT);
    expect(notice(/O freelancer tem até/)).toBe(
      'O freelancer tem até sex, 02/10, às 09:00 para responder; sem resposta, a proposta se encerra e o valor reservado volta para a sua carteira.',
    );
  });

  it('proposta em créditos: nada foi reservado, então o aviso não fala em carteira', async () => {
    api.contractDetail.mockResolvedValue(proposal({ paymentMode: 'credits' }));
    await openSala(CLIENT);
    expect(notice(/O freelancer tem até/)).toBe(
      'O freelancer tem até sex, 02/10, às 09:00 para responder; sem resposta, a proposta se encerra.',
    );
  });

  it('quem não é parte da contratação não recebe aviso de prazo para agir', async () => {
    api.contractDetail.mockResolvedValue(delivered());
    await openSala(99);
    expect(screen.queryByText(/Entrega registrada\./)).toBeNull();
  });

  it('em andamento, sem entrega nem proposta, não há aviso', async () => {
    await openSala(CLIENT);
    expect(screen.queryByText(/Entrega registrada\.|Responda até|O freelancer tem até/)).toBeNull();
  });

  it('entrega ou proposta sem data-limite gravada não ganham aviso', async () => {
    api.contractDetail.mockResolvedValue(delivered({ approvalDueAt: null }));
    const { unmount } = await openSala(CLIENT);
    expect(screen.queryByText(/Entrega registrada\./)).toBeNull();
    unmount();

    api.contractDetail.mockResolvedValue(proposal({ proposalExpiresAt: null }));
    await openSala(FREELANCER);
    expect(screen.queryByText(/Responda até/)).toBeNull();
  });
});

describe('SalaContratoView: chat', () => {
  const texts = (): string[] =>
    within(card('Chat'))
      .getAllByText(/^(Bom dia|Tudo certo\?|Sim, começo hoje|Nova do socket)$/)
      .map((el) => el.textContent ?? '');

  it('sem mensagens, convida a começar a conversa', async () => {
    await openSala();
    expect(within(card('Chat')).getByText('Nenhuma mensagem ainda. Diga oi!')).toBeVisible();
    expect(sendButton()).toBeDisabled();
  });

  it('mostra o histórico na ordem em que as mensagens foram enviadas', async () => {
    api.chatHistory.mockResolvedValue(
      history([
        message({ id: 3, content: 'Sim, começo hoje' }),
        message({ id: 1, content: 'Bom dia' }),
        message({ id: 2, senderId: CLIENT, content: 'Tudo certo?' }),
      ]),
    );
    await openSala();
    expect(texts()).toEqual(['Bom dia', 'Tudo certo?', 'Sim, começo hoje']);
    expect(screen.queryByText('Nenhuma mensagem ainda. Diga oi!')).toBeNull();
  });

  it('socket desconectado mostra "offline"; ao conectar entra na sala do contrato e fica "ao vivo"', async () => {
    await openSala();
    const chat = within(card('Chat'));
    expect(chat.getByText('offline')).toBeVisible();
    expect(socket.emit).not.toHaveBeenCalled();

    act(() => socket.fire('connect'));
    expect(chat.getByText('ao vivo')).toBeVisible();
    expect(chat.queryByText('offline')).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('contract:join', ID);

    act(() => socket.fire('disconnect'));
    expect(chat.getByText('offline')).toBeVisible();
  });

  it('socket já conectado: entra na sala assim que a tela abre', async () => {
    socket.connected = true;
    await openSala();
    expect(within(card('Chat')).getByText('ao vivo')).toBeVisible();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('contract:join', ID);
  });

  it('mensagem que chega pelo socket entra no fim, sem duplicar, e rola o chat até ela', async () => {
    api.chatHistory.mockResolvedValue(history([message({ id: 1, content: 'Bom dia' })]));
    await openSala();
    scrollIntoView.mockClear();
    const incoming = { ...message({ id: 8, content: 'Nova do socket' }), contractId: ID };
    act(() => socket.fire('message:new', incoming));
    expect(texts()).toEqual(['Bom dia', 'Nova do socket']);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });

    // A mesma mensagem de novo (reconexão) não vira uma segunda bolha.
    act(() => socket.fire('message:new', incoming));
    expect(texts()).toEqual(['Bom dia', 'Nova do socket']);
  });

  it('mensagem de outra contratação é ignorada', async () => {
    api.chatHistory.mockResolvedValue(history([message({ id: 1, content: 'Bom dia' })]));
    await openSala();
    act(() =>
      socket.fire('message:new', {
        ...message({ id: 8, content: 'Nova do socket' }),
        contractId: 10,
      }),
    );
    act(() =>
      socket.fire('message:updated', {
        ...message({ id: 1, content: '', removedAt: '2026-10-01T14:30:00.000Z' }),
        contractId: 10,
      }),
    );
    expect(texts()).toEqual(['Bom dia']);
    expect(screen.queryByText('Mensagem removida pela moderação')).toBeNull();
  });

  it('mensagem removida pela moderação troca a bolha no lugar, sem o texto', async () => {
    api.chatHistory.mockResolvedValue(
      history([
        message({ id: 1, content: 'Bom dia' }),
        message({ id: 2, senderId: CLIENT, content: 'Tudo certo?' }),
      ]),
    );
    await openSala();
    act(() =>
      socket.fire('message:updated', {
        ...message({ id: 1, content: '', removedAt: '2026-10-01T14:30:00.000Z' }),
        contractId: ID,
      }),
    );
    const chat = card('Chat');
    expect(texts()).toEqual(['Tudo certo?']);
    const removed = within(chat).getByText('Mensagem removida pela moderação');
    // A bolha removida continua antes da mensagem seguinte.
    expect(
      removed.compareDocumentPosition(within(chat).getByText('Tudo certo?')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('ao sair da Sala, ninguém mais fica ouvindo o socket', async () => {
    const { unmount } = await openSala();
    expect(
      ['connect', 'disconnect', 'message:new', 'message:updated'].map((e) => socket.count(e)),
    ).toEqual([1, 1, 1, 1]);
    unmount();
    expect(
      ['connect', 'disconnect', 'message:new', 'message:updated'].map((e) => socket.count(e)),
    ).toEqual([0, 0, 0, 0]);
  });

  it('mensagem com sinal de negociação por fora leva o aviso do escrow', async () => {
    api.chatHistory.mockResolvedValue(
      history([
        message({ id: 1, content: 'Bom dia' }),
        message({ id: 2, content: 'Me paga no pix', signals: ['pix'] }),
      ]),
    );
    await openSala();
    const flagged = screen.getByText('Me paga no pix').parentElement!;
    expect(within(flagged).getByText('Fora do Escambo não há proteção do escrow')).toBeVisible();
    const clean = screen.getByText('Bom dia').parentElement!;
    expect(within(clean).queryByText('Fora do Escambo não há proteção do escrow')).toBeNull();
  });

  it('anexos: arquivo vira botão de baixar, imagem é buscada com o token e arquivo expurgado diz o motivo', async () => {
    api.attachmentBlob.mockReturnValue(new Promise(() => undefined));
    api.chatHistory.mockResolvedValue(
      history([
        message({ id: 1, type: 'file', content: 'Segue o briefing', attachment: attachment() }),
        message({
          id: 2,
          type: 'image',
          content: '',
          attachment: attachment({
            name: 'capa.png',
            mime: 'image/png',
            url: '/api/messaging/attachments/78',
          }),
        }),
        message({
          id: 3,
          type: 'image',
          content: '',
          attachment: attachment({
            name: 'antiga.png',
            mime: 'image/png',
            purgedAt: '2026-09-30T00:00:00.000Z',
            purgedReason: 'retention',
          }),
        }),
      ]),
    );
    await openSala();
    const file = screen.getByRole('button', { name: 'Baixar briefing.pdf' });
    expect(file).toHaveTextContent('2 KB');
    expect(screen.getByText('Segue o briefing')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Carregando imagem' })).toBeInTheDocument();
    expect(api.attachmentBlob).toHaveBeenCalledWith('/api/messaging/attachments/78', 'capa.png');
    expect(api.attachmentBlob).toHaveBeenCalledTimes(1);
    expect(screen.getByText('antiga.png')).toBeInTheDocument();
    expect(screen.getByText('removido pela política de retenção')).toBeInTheDocument();
  });
});

describe('SalaContratoView: enviar mensagem', () => {
  it('envia o texto sem espaços nas pontas, mostra a mensagem e limpa o campo', async () => {
    const user = userEvent.setup({ delay: null });
    api.sendMessage.mockResolvedValue(message({ id: 50, senderId: CLIENT, content: 'Combinado!' }));
    await openSala();
    await user.type(draftInput(), '  Combinado! ');
    await user.click(sendButton());

    expect(api.sendMessage).toHaveBeenCalledWith(ID, 'Combinado!');
    expect(api.sendAttachment).not.toHaveBeenCalled();
    expect(await within(card('Chat')).findByText('Combinado!')).toBeVisible();
    expect(draftInput()).toHaveValue('');
    expect(sendButton()).toBeDisabled();
    // O histórico é buscado de novo, para a conversa ficar igual à do servidor.
    await waitFor(() => expect(api.chatHistory).toHaveBeenCalledTimes(2));
    expect(api.chatHistory).toHaveBeenLastCalledWith(ID);
  });

  it.todo(
    'histórico do chat que não carrega mostra o erro e deixa tentar de novo (defeito: SalaContratoView.tsx:496 só olha history.isLoading; com a API recusando, a tela diz "Nenhuma mensagem ainda. Diga oi!" como se a conversa estivesse vazia)',
  );

  it('Enter no campo envia; só espaços não libera o botão', async () => {
    const user = userEvent.setup({ delay: null });
    api.sendMessage.mockResolvedValue(message({ id: 51, senderId: CLIENT, content: 'Oi' }));
    await openSala();
    await user.type(draftInput(), '   ');
    expect(sendButton()).toBeDisabled();
    await user.type(draftInput(), 'Oi{Enter}');
    expect(api.sendMessage).toHaveBeenCalledWith(ID, 'Oi');
  });

  it('a mensagem enviada não duplica quando o socket devolve a mesma mensagem', async () => {
    const user = userEvent.setup({ delay: null });
    const sent = message({ id: 52, senderId: CLIENT, content: 'Fechado' });
    api.sendMessage.mockResolvedValue(sent);
    await openSala();
    await user.type(draftInput(), 'Fechado');
    await user.click(sendButton());
    await within(card('Chat')).findByText('Fechado');
    act(() => socket.fire('message:new', { ...sent, contractId: ID }));
    expect(within(card('Chat')).getAllByText('Fechado')).toHaveLength(1);
  });

  it('recusa da API: mostra o motivo e o texto continua no campo', async () => {
    const user = userEvent.setup({ delay: null });
    api.sendMessage.mockRejectedValue(new Error('Contratação encerrada: o chat está fechado.'));
    await openSala();
    await user.type(draftInput(), 'Ainda dá tempo?');
    await user.click(sendButton());
    expect(
      await screen.findByText('Contratação encerrada: o chat está fechado.'),
    ).toBeInTheDocument();
    expect(draftInput()).toHaveValue('Ainda dá tempo?');
    expect(within(card('Chat')).getByText('Nenhuma mensagem ainda. Diga oi!')).toBeVisible();
  });

  it('enquanto envia, anexar e enviar ficam desabilitados', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (m: ChatMessage) => void = () => undefined;
    api.sendMessage.mockReturnValue(
      new Promise<ChatMessage>((resolve) => {
        finish = resolve;
      }),
    );
    await openSala();
    await user.type(draftInput(), 'Oi');
    await user.click(sendButton());
    await waitFor(() => expect(sendButton()).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Anexar arquivo' })).toBeDisabled();
    await act(async () => finish(message({ id: 53, senderId: CLIENT, content: 'Oi' })));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Anexar arquivo' })).toBeEnabled(),
    );
  });

  it('avisa, enquanto a pessoa digita, que combinar por fora perde a proteção do escrow', async () => {
    const user = userEvent.setup({ delay: null });
    await openSala();
    await user.type(draftInput(), 'bom dia, tudo bem?');
    expect(screen.queryByText(/na mensagem: pagamento fora do Escambo/)).toBeNull();

    await user.clear(draftInput());
    await user.type(draftInput(), 'me paga no pix por fora');
    expect(
      screen.getByText(
        'Pix e negociar por fora na mensagem: pagamento fora do Escambo não tem a proteção do escrow, e a mensagem vai para a moderação.',
      ),
    ).toBeVisible();

    await user.clear(draftInput());
    await user.type(draftInput(), 'me chama no whatsapp');
    expect(screen.getByText(/^WhatsApp na mensagem: pagamento fora do Escambo/)).toBeVisible();
  });
});

describe('SalaContratoView: enviar anexo', () => {
  it('arquivo escolhido aparece antes de enviar e vai sem legenda quando o campo está vazio', async () => {
    const user = userEvent.setup({ delay: null });
    const file = pdf();
    api.sendAttachment.mockResolvedValue(
      message({
        id: 60,
        senderId: CLIENT,
        type: 'file',
        content: '',
        attachment: attachment({ name: 'roteiro.pdf' }),
      }),
    );
    await openSala();
    expect(
      screen.getByText('Imagem, PDF ou ZIP até 10 MB: clipe, colar ou arrastar aqui.'),
    ).toBeVisible();
    await user.upload(screen.getByTestId('attachment-input'), file);

    expect(screen.getByText('roteiro.pdf')).toBeVisible();
    expect(screen.getByPlaceholderText('Legenda (opcional)…')).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();

    await user.click(sendButton());
    expect(api.sendAttachment).toHaveBeenCalledWith(ID, file, undefined);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Baixar roteiro.pdf' })).toBeVisible();
    // O anexo pendente sai e o campo volta a ser de mensagem.
    expect(screen.queryByRole('button', { name: 'Remover anexo' })).toBeNull();
    expect(screen.getByPlaceholderText('Escreva uma mensagem…')).toBeInTheDocument();
  });

  it('com texto no campo, ele vai como legenda do anexo', async () => {
    const user = userEvent.setup({ delay: null });
    const file = pdf();
    api.sendAttachment.mockResolvedValue(
      message({
        id: 61,
        senderId: CLIENT,
        type: 'file',
        content: 'Versão final',
        attachment: attachment({ name: 'roteiro.pdf' }),
      }),
    );
    await openSala();
    await user.upload(screen.getByTestId('attachment-input'), file);
    await user.type(draftInput(), ' Versão final ');
    await user.click(sendButton());
    expect(api.sendAttachment).toHaveBeenCalledWith(ID, file, 'Versão final');
  });

  it('o clipe abre o seletor de arquivos do aparelho', async () => {
    const user = userEvent.setup({ delay: null });
    await openSala();
    const picker = vi.spyOn(screen.getByTestId('attachment-input'), 'click');
    const clip = screen.getByRole('button', { name: 'Anexar arquivo' });
    expect(clip).toHaveAttribute('title', 'Imagem, PDF ou ZIP até 10 MB');
    await user.click(clip);
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('"Remover anexo" desiste do arquivo sem enviar nada', async () => {
    const user = userEvent.setup({ delay: null });
    await openSala();
    await user.upload(screen.getByTestId('attachment-input'), pdf());
    await user.click(screen.getByRole('button', { name: 'Remover anexo' }));
    expect(screen.queryByText('roteiro.pdf')).toBeNull();
    expect(sendButton()).toBeDisabled();
    expect(api.sendAttachment).not.toHaveBeenCalled();
  });

  it('arquivo acima de 10 MB é recusado na hora, sem chegar à API', async () => {
    const user = userEvent.setup({ delay: null });
    const big = pdf('filme.pdf');
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    await openSala();
    await user.upload(screen.getByTestId('attachment-input'), big);
    expect(await screen.findByText('Arquivo maior que 10 MB')).toBeVisible();
    expect(screen.queryByText('filme.pdf')).toBeNull();
    expect(sendButton()).toBeDisabled();
  });

  it('arquivo de exatamente 10 MB ainda é aceito', async () => {
    const user = userEvent.setup({ delay: null });
    const limit = pdf('limite.pdf');
    Object.defineProperty(limit, 'size', { value: 10 * 1024 * 1024 });
    await openSala();
    await user.upload(screen.getByTestId('attachment-input'), limit);
    expect(screen.getByText('limite.pdf')).toBeVisible();
    expect(screen.queryByText('Arquivo maior que 10 MB')).toBeNull();
  });

  it('colar um arquivo no campo anexa; colar só texto não', async () => {
    await openSala();
    // Texto colado segue o caminho normal do navegador (o evento não é cancelado).
    expect(fireEvent.paste(draftInput(), { clipboardData: { files: [] } })).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remover anexo' })).toBeNull();

    // Arquivo colado vira anexo e não cai no campo de texto (o evento é cancelado).
    expect(fireEvent.paste(draftInput(), { clipboardData: { files: [pdf('colado.pdf')] } })).toBe(
      false,
    );
    expect(screen.getByText('colado.pdf')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remover anexo' })).toBeVisible();
  });

  it('arrastar um arquivo para o chat anexa', async () => {
    await openSala();
    const chat = card('Chat');
    fireEvent.dragOver(chat);
    fireEvent.drop(chat, { dataTransfer: { files: [pdf('arrastado.pdf')] } });
    expect(within(chat).getByText('arrastado.pdf')).toBeVisible();
    expect(sendButton()).toBeEnabled();
  });

  it('enquanto o anexo sobe, anexar e enviar ficam desabilitados', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (m: ChatMessage) => void = () => undefined;
    api.sendAttachment.mockReturnValue(
      new Promise<ChatMessage>((resolve) => {
        finish = resolve;
      }),
    );
    await openSala();
    await user.upload(screen.getByTestId('attachment-input'), pdf());
    await user.click(sendButton());
    await waitFor(() => expect(sendButton()).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Anexar arquivo' })).toBeDisabled();

    await act(async () =>
      finish(
        message({
          id: 62,
          senderId: CLIENT,
          type: 'file',
          content: '',
          attachment: attachment({ name: 'roteiro.pdf' }),
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Baixar roteiro.pdf' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Anexar arquivo' })).toBeEnabled();
    expect(api.sendAttachment).toHaveBeenCalledTimes(1);
  });

  it('recusa da API no anexo: mostra o motivo e o arquivo continua pronto para tentar de novo', async () => {
    const user = userEvent.setup({ delay: null });
    api.sendAttachment.mockRejectedValue(new Error('Tipo de arquivo não aceito'));
    await openSala();
    await user.upload(screen.getByTestId('attachment-input'), pdf());
    await user.click(sendButton());
    expect(await screen.findByText('Tipo de arquivo não aceito')).toBeInTheDocument();
    expect(screen.getByText('roteiro.pdf')).toBeVisible();
  });
});

describe('SalaContratoView: avaliação', () => {
  const completed = (o: Partial<ContractWithHistory> = {}) =>
    contract({ status: 'completed', ...o });

  it('antes de concluir, não há seção de avaliação', async () => {
    await openSala();
    expect(screen.queryByRole('heading', { name: 'Avaliação' })).toBeNull();
  });

  it('cliente: escolhe a nota, comenta e envia; a avaliação enviada passa a aparecer', async () => {
    const user = userEvent.setup({ delay: null });
    const saved = review({ rating: 5, comment: 'Excelente trabalho' });
    api.contractDetail
      .mockResolvedValueOnce(completed())
      .mockResolvedValue(completed({ hasReview: true, review: saved }));
    api.createReview.mockResolvedValue(saved);
    await openSala(CLIENT);
    const section = within(card('Avaliação'));
    const submit = section.getByRole('button', { name: 'Enviar avaliação' });
    // Sem nota não dá para enviar.
    expect(submit).toBeDisabled();
    expect(section.getByText('Escolha a nota')).toBeInTheDocument();
    // Na Sala a avaliação é a própria seção: o botão "Avaliar" da lista não se repete aqui.
    expect(screen.queryByRole('button', { name: 'Avaliar' })).toBeNull();

    await user.click(
      within(section.getByRole('radiogroup', { name: 'Nota' })).getByRole('radio', {
        name: '5 estrelas',
      }),
    );
    await user.type(section.getByLabelText('Comentário da avaliação'), ' Excelente trabalho ');
    await user.click(submit);

    expect(api.createReview).toHaveBeenCalledWith({
      contractId: ID,
      rating: 5,
      comment: 'Excelente trabalho',
    });
    expect(await screen.findByText('Avaliação enviada. Obrigado!')).toBeInTheDocument();
    expect(await section.findByText('Excelente trabalho')).toBeVisible();
    expect(section.getByText(`avaliado em ${dtm(saved.createdAt)}`)).toBeInTheDocument();
    expect(section.getByRole('img', { name: '5.0 de 5' })).toBeInTheDocument();
    expect(section.queryByRole('button', { name: 'Enviar avaliação' })).toBeNull();
  });

  it('cliente: sem comentário, a avaliação vai com comentário nulo', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockResolvedValue(completed());
    api.createReview.mockResolvedValue(review({ rating: 3, comment: null }));
    await openSala(CLIENT);
    const section = within(card('Avaliação'));
    await user.click(section.getByRole('radio', { name: '3 estrelas' }));
    await user.click(section.getByRole('button', { name: 'Enviar avaliação' }));
    expect(api.createReview).toHaveBeenCalledWith({ contractId: ID, rating: 3, comment: null });
  });

  it('cliente: avaliação recusada pela API mostra o motivo e o formulário continua', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockResolvedValue(completed());
    api.createReview.mockRejectedValue(new Error('O prazo de 7 dias para avaliar acabou.'));
    await openSala(CLIENT);
    const section = within(card('Avaliação'));
    await user.click(section.getByRole('radio', { name: '4 estrelas' }));
    await user.click(section.getByRole('button', { name: 'Enviar avaliação' }));
    expect(await screen.findByText('O prazo de 7 dias para avaliar acabou.')).toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Enviar avaliação' })).toBeEnabled();
  });

  it('cliente: enquanto a avaliação é enviada, o botão trava dizendo "Enviando…"', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (r: Review) => void = () => undefined;
    api.contractDetail.mockResolvedValue(completed());
    api.createReview.mockReturnValue(
      new Promise<Review>((resolve) => {
        finish = resolve;
      }),
    );
    await openSala(CLIENT);
    const section = within(card('Avaliação'));
    await user.click(section.getByRole('radio', { name: '5 estrelas' }));
    await user.click(section.getByRole('button', { name: 'Enviar avaliação' }));
    const sending = await section.findByRole('button', { name: 'Enviando…' });
    expect(sending).toBeDisabled();
    await user.click(sending);
    expect(api.createReview).toHaveBeenCalledTimes(1);
    await act(async () => finish(review({ rating: 5 })));
    expect(await screen.findByText('Avaliação enviada. Obrigado!')).toBeInTheDocument();
  });

  it('freelancer, sem avaliação ainda: só espera o cliente', async () => {
    api.contractDetail.mockResolvedValue(completed());
    await openSala(FREELANCER);
    const section = within(card('Avaliação'));
    expect(section.getByText('Aguardando a avaliação do cliente.')).toBeVisible();
    expect(section.queryByRole('radiogroup')).toBeNull();
  });

  it('freelancer: responde à avaliação uma vez, com o texto sem espaços nas pontas', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockResolvedValue(completed({ hasReview: true, review: review() }));
    api.respondReview.mockResolvedValue({ ok: true });
    await openSala(FREELANCER);
    const section = within(card('Avaliação'));
    expect(section.getByText('Ficou ótimo.')).toBeVisible();
    expect(section.getByRole('img', { name: '4.0 de 5' })).toBeInTheDocument();
    const reply = section.getByRole('button', { name: 'Responder' });
    expect(reply).toBeDisabled();

    await user.type(section.getByLabelText('Resposta à avaliação'), ' Obrigado pela parceria! ');
    await user.click(reply);
    expect(api.respondReview).toHaveBeenCalledWith(55, 'Obrigado pela parceria!');
    expect(await screen.findByText('Resposta publicada')).toBeInTheDocument();
  });

  it('freelancer: enquanto publica, "Publicando…" trava; publicada, a resposta substitui o campo', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: () => void = () => undefined;
    api.contractDetail
      .mockResolvedValueOnce(completed({ hasReview: true, review: review() }))
      .mockResolvedValue(
        completed({ hasReview: true, review: review({ response: 'Obrigado pela parceria!' }) }),
      );
    api.respondReview.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        finish = () => resolve({ ok: true });
      }),
    );
    await openSala(FREELANCER);
    const section = within(card('Avaliação'));
    await user.type(section.getByLabelText('Resposta à avaliação'), 'Obrigado pela parceria!');
    await user.click(section.getByRole('button', { name: 'Responder' }));
    const publishing = await section.findByRole('button', { name: 'Publicando…' });
    expect(publishing).toBeDisabled();
    await user.click(publishing);
    expect(api.respondReview).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(await section.findByText('Resposta do freelancer')).toBeVisible();
    expect(section.getByText('Obrigado pela parceria!')).toBeVisible();
    expect(section.queryByLabelText('Resposta à avaliação')).toBeNull();
  });

  it('freelancer: resposta recusada pela API mostra o motivo', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockResolvedValue(completed({ hasReview: true, review: review() }));
    api.respondReview.mockRejectedValue(new Error('Esta avaliação já foi respondida.'));
    await openSala(FREELANCER);
    const section = within(card('Avaliação'));
    await user.type(section.getByLabelText('Resposta à avaliação'), 'Obrigado!');
    await user.click(section.getByRole('button', { name: 'Responder' }));
    expect(await screen.findByText('Esta avaliação já foi respondida.')).toBeInTheDocument();
  });

  it('cliente vê a própria avaliação sem campo de resposta; a resposta do freelancer aparece quando existe', async () => {
    api.contractDetail.mockResolvedValue(completed({ hasReview: true, review: review() }));
    const { unmount } = await openSala(CLIENT);
    expect(within(card('Avaliação')).getByText('Ficou ótimo.')).toBeVisible();
    expect(within(card('Avaliação')).queryByLabelText('Resposta à avaliação')).toBeNull();
    unmount();

    api.contractDetail.mockResolvedValue(
      completed({
        hasReview: true,
        review: review({ comment: null, response: 'Obrigado pela parceria!' }),
      }),
    );
    await openSala(FREELANCER);
    const section = within(card('Avaliação'));
    expect(section.getByText('Sem comentário.')).toBeVisible();
    expect(section.getByText('Resposta do freelancer')).toBeVisible();
    expect(section.getByText('Obrigado pela parceria!')).toBeVisible();
    // Já respondida: não há segunda resposta.
    expect(section.queryByLabelText('Resposta à avaliação')).toBeNull();
  });

  it('avaliação removida pela moderação: só o aviso, sem nota nem comentário', async () => {
    api.contractDetail.mockResolvedValue(
      completed({
        hasReview: true,
        review: review({ removedAt: '2026-10-01T10:00:00.000Z' }),
      }),
    );
    await openSala(FREELANCER);
    const section = within(card('Avaliação'));
    expect(
      section.getByText(
        'Esta avaliação foi removida pela moderação e não aparece no perfil do freelancer.',
      ),
    ).toBeVisible();
    expect(section.queryByText('Ficou ótimo.')).toBeNull();
    expect(section.queryByRole('img', { name: /de 5$/ })).toBeNull();
    expect(section.queryByLabelText('Resposta à avaliação')).toBeNull();
  });
});

describe('SalaContratoView: ações da contratação', () => {
  const terms: CancelTerms = {
    allowed: true,
    by: 'client',
    stage: 'early',
    refundPercentage: 50,
    refundClient: 100,
    releaseFreelancer: 85,
    unit: 'BRL',
    code: null,
    message: null,
    availableAt: null,
    noticeAt: null,
  };

  it('"Abrir disputa" abre o diálogo da contratação e envia motivo e descrição', async () => {
    const user = userEvent.setup({ delay: null });
    api.openDispute.mockResolvedValue({ id: 1, contractId: ID });
    await openSala(CLIENT);
    await user.click(screen.getByRole('button', { name: 'Abrir disputa' }));
    const dialog = screen.getByRole('dialog', { name: 'Abrir disputa: Vídeo institucional' });
    await user.type(
      within(dialog).getByLabelText('Descrição da disputa'),
      'O vídeo veio sem a trilha combinada.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Abrir disputa' }));

    expect(api.openDispute).toHaveBeenCalledWith({
      contractId: ID,
      reason: 'quality',
      description: 'O vídeo veio sem a trilha combinada.',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('"Cancelar" abre o diálogo com o valor antes de confirmar; "Voltar" fecha sem cancelar', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockResolvedValue(contract({ cancellation: terms }));
    await openSala(CLIENT);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancelar contratação' });
    expect(read(dialog)).toContain('Você recebe de voltaR$ 100,00');
    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cliente aprova a entrega pela Sala', async () => {
    const user = userEvent.setup({ delay: null });
    api.contractDetail.mockResolvedValue(contract({ status: 'delivered' }));
    api.contractAction.mockResolvedValue(contract({ status: 'completed' }));
    await openSala(CLIENT);
    await user.click(screen.getByRole('button', { name: 'Aprovar entrega' }));
    expect(api.contractAction).toHaveBeenCalledWith(ID, 'approve');
    expect(
      await screen.findByText('Entrega aprovada. Valor liberado para o freelancer.'),
    ).toBeInTheDocument();
  });

  it('quem não é parte não vê botões de ação', async () => {
    await openSala(99);
    expect(screen.queryByRole('button', { name: 'Abrir disputa' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
  });

  it('em disputa, mostra o estado da disputa desta contratação', async () => {
    const dispute: Dispute = {
      id: 4,
      ulid: 'd-4',
      contractId: ID,
      openedBy: CLIENT,
      reason: 'deadline',
      description: 'Passou do prazo sem entrega.',
      status: 'under_review',
      resolution: null,
      refundPercentage: null,
      createdAt: '2026-10-01T12:00:00.000Z',
    };
    api.contractDetail.mockResolvedValue(contract({ status: 'disputed' }));
    api.disputes.mockResolvedValue([
      { ...dispute, id: 3, contractId: 10, description: 'Outra.' },
      dispute,
    ]);
    await openSala(CLIENT);
    const section = within(card('Disputa'));
    expect(await section.findByText('Prazo não cumprido')).toBeVisible();
    expect(section.getByText('Passou do prazo sem entrega.')).toBeVisible();
    expect(section.getByText('Em análise')).toBeVisible();
    expect(section.queryByText('Outra.')).toBeNull();
  });

  it('fora de disputa, a seção de disputa não aparece nem é consultada', async () => {
    await openSala(CLIENT);
    expect(screen.queryByRole('heading', { name: 'Disputa' })).toBeNull();
    expect(api.disputes).not.toHaveBeenCalled();
  });
});
