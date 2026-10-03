import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ContractDeadline,
  ContractExtension,
  ContractWithHistory,
  Milestone,
} from '@escambo/types';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DeadlineSection, RevisionSince } from './DeadlineSection';

const resolveExtension = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    resolveExtension: (id: number, d: string, seq?: number) => resolveExtension(id, d, seq),
    publicSettings: () => Promise.resolve({ extensionResponseHours: 48 }),
  },
}));
// Quem lê a Sala: o fuso muda por teste (o prazo é um dia no fuso de quem entrega, ADR 58).
const auth = vi.hoisted(() => ({
  user: { id: 1, timezone: 'America/Sao_Paulo' as string | null },
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const CLIENT = 1;
const FREELANCER = 2;

/** Fim do dia em Brasília (UTC−3): o texto da tela não depende do fuso da máquina que roda. */
const endOfBrasiliaDay = (month: number, day: number): string =>
  new Date(Date.UTC(2026, month - 1, day + 1, 2, 59, 59)).toISOString();

function contract(
  deadline: Partial<ContractDeadline>,
  o: Partial<ContractWithHistory> = {},
): ContractWithHistory {
  return {
    id: 9,
    clientId: CLIENT,
    freelancerId: FREELANCER,
    title: 'Vídeo',
    status: 'accepted',
    hasMilestones: false,
    deadlineAt: '2026-10-03T02:59:59.000Z',
    deadlineZone: 'America/Sao_Paulo',
    revisionRequestedAt: null,
    deadlineExtendedAt: null,
    extension: null,
    milestones: [],
    deadline: {
      state: 'running',
      noticeAt: '2026-10-03T12:00:00.000Z',
      mediationAt: '2026-10-04T12:00:00.000Z',
      extensionRequestsLeft: 2,
      undeliveredMilestones: 0,
      totalMilestones: 0,
      firstDeliveredAt: null,
      ...deadline,
    },
    ...o,
  } as unknown as ContractWithHistory;
}

const section = (): HTMLElement => screen.getByRole('region', { name: 'Prazo de entrega' });

/** Agora: qui, 01/10/2026, meio-dia em Brasília. */
const NOW = '2026-10-01T15:00:00.000Z';

// O relógio da tela fica antes das horas dos exemplos (o aviso de 03/10 ainda não saiu).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  vi.setSystemTime(new Date(NOW));
  auth.user = { id: 1, timezone: 'America/Sao_Paulo' };
  resolveExtension.mockReset();
  resolveExtension.mockResolvedValue({});
});

/** A seção de prazo pelo estado que a API calculou (ADR 57), para as duas partes. */
describe('DeadlineSection', () => {
  it('prazo vencido antes do aviso: cada um lê o que vai acontecer e quando', () => {
    const c = contract({ state: 'due' });
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(within(section()).getByText('venceu')).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'O prazo venceu sem entrega. O Escambo avisa vocês dois a partir de sáb, 03/10, às 09:00, e daí em diante o cliente pode cancelar com reembolso integral. Registre a entrega ou peça a extensão antes disso.',
      ),
    ).toBeInTheDocument();
    expect(within(section()).getByText('até 2 pedidos; só um pode ser aceito')).toBeInTheDocument();
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(
      within(section()).getByText(
        'O prazo venceu sem entrega. O Escambo avisa o freelancer a partir de sáb, 03/10, às 09:00; daí em diante você pode cancelar com reembolso integral, ou esperar: sem entrega, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir extensão de prazo' })).toBeNull();
  });

  it('carência: até quando agir; com marco entregue em aberto, sem a frase do cancelamento', () => {
    const grace = { state: 'grace' as const, extensionRequestsLeft: 1 };
    const { unmount } = render(
      wrap(<DeadlineSection contract={contract(grace)} myId={FREELANCER} />),
    );
    expect(within(section()).getByText('vencido')).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'Prazo vencido. Até dom, 04/10, às 09:00: registre a entrega ou peça a extensão, senão a disputa abre sozinha e o valor fica congelado até a decisão da mediação. O cliente já pode cancelar com reembolso integral.',
      ),
    ).toBeInTheDocument();
    expect(within(section()).getByText('resta 1 pedido')).toBeInTheDocument();
    unmount();
    const marcos = contract(
      { ...grace, undeliveredMilestones: 1, totalMilestones: 2 },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'delivered', deliveredAt: '2026-10-01T12:00:00.000Z' },
          { id: 2, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    render(wrap(<DeadlineSection contract={marcos} myId={CLIENT} />));
    // Nada de "sem entrega" (houve marco entregue) nem de oferta de cancelamento (ele trava).
    expect(
      within(section()).getByText(
        'Faltam 1 de 2 marcos. Prazo vencido. Sem as entregas que faltam nem extensão aceita até dom, 04/10, às 09:00, a disputa abre sozinha e a mediação do Escambo decide.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sem entrega|cancelar/)).toBeNull();
  });

  it('prazo vencido com marco entregue em aberto: nada de "sem entrega" nem oferta de cancelamento', () => {
    const c = contract(
      { state: 'due', undeliveredMilestones: 1, totalMilestones: 2 },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'delivered', deliveredAt: '2026-10-01T12:00:00.000Z' },
          { id: 2, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(
      within(section()).getByText(
        'O prazo venceu com um marco por entregar. O Escambo avisa o freelancer a partir de sáb, 03/10, às 09:00: sem as entregas que faltam, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
      ),
    ).toBeInTheDocument();
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(
      within(section()).getByText(
        'O prazo venceu com um marco por entregar. O Escambo avisa vocês dois a partir de sáb, 03/10, às 09:00. Entregue o marco que falta ou peça a extensão antes disso.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/cancelar/)).toBeNull();
  });

  it('aviso projetado já no passado (job atrasado): "a qualquer momento" e o cancelamento já vale', () => {
    const c = contract({ state: 'due', noticeAt: '2026-10-01T12:00:00.000Z' });
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(
      within(section()).getByText(
        'O prazo venceu sem entrega. O Escambo avisa vocês dois a qualquer momento, e o cliente já pode cancelar com reembolso integral. Registre a entrega ou peça a extensão.',
      ),
    ).toBeInTheDocument();
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(
      within(section()).getByText(
        'O prazo venceu sem entrega. Você já pode cancelar com reembolso integral, ou esperar: sem entrega, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
      ),
    ).toBeInTheDocument();
  });

  it('pedido de extensão: o cliente vê até quando responder e decide o pedido que viu', async () => {
    const user = userEvent.setup();
    const c = contract(
      { state: 'paused' },
      {
        deadlineAt: '2025-12-01T02:59:59.000Z', // já vencido pelo relógio da tela
        extension: {
          status: 'pending',
          deadlineAt: endOfBrasiliaDay(10, 9),
          reason: 'Material atrasou',
          requestedAt: '2026-10-01T12:00:00.000Z',
          resolvedAt: null,
          respondBy: '2026-10-03T12:00:00.000Z',
          seq: 2,
          deadlineZone: 'America/Sao_Paulo',
        },
      },
    );
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(within(section()).getByText('extensão pedida')).toBeInTheDocument();
    expect(
      within(section()).getByText('Extensão pedida: novo prazo sex, 09/10/2026, até 23:59'),
    ).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'Responda até sáb, 03/10, às 09:00. Sem resposta, o pedido expira e vale o prazo atual. Enquanto você decide, a disputa automática espera.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(resolveExtension).toHaveBeenCalledTimes(1);
    expect(resolveExtension).toHaveBeenCalledWith(9, 'decline', 2);
    expect(await screen.findByText('Extensão recusada; vale o prazo atual.')).toBeInTheDocument();
  });

  it('houve entrega: o prazo não cobra mais; em revisão sem a hora do pedido (antes do reparo), nada de "Revisão pedida"', () => {
    const met = contract(
      { state: 'met', firstDeliveredAt: '2026-10-02T12:00:00.000Z' },
      { status: 'revision_requested', revisionRequestedAt: null },
    );
    render(wrap(<DeadlineSection contract={met} myId={CLIENT} />));
    expect(within(section()).getByText('entregue')).toBeInTheDocument();
    expect(screen.getByTestId('deadline-met').textContent).toBe(
      'Houve entrega em sex, 02/10, às 09:00: o prazo não abre mais disputa sozinho.',
    );
    expect(screen.queryByTestId('revision-since')).toBeNull();
    expect(screen.queryByText(/venceu|vencido/)).toBeNull();
  });

  it('pedido recusado e pedido expirado aparecem com o que vale agora', () => {
    const ext = {
      deadlineAt: endOfBrasiliaDay(10, 9),
      reason: 'x',
      requestedAt: '2026-10-01T12:00:00.000Z',
      resolvedAt: '2026-10-03T12:00:00.000Z',
      respondBy: '2026-10-03T12:00:00.000Z',
      seq: 1,
      deadlineZone: 'America/Sao_Paulo' as const,
    };
    const { unmount } = render(
      wrap(
        <DeadlineSection
          contract={contract(
            { extensionRequestsLeft: 1 },
            { extension: { ...ext, status: 'declined' } },
          )}
          myId={FREELANCER}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59) recusado; vale o prazo atual. Você ainda pode fazer mais um pedido.',
      ),
    ).toBeInTheDocument();
    unmount();
    render(
      wrap(
        <DeadlineSection
          contract={contract({}, { extension: { ...ext, status: 'expired' } })}
          myId={CLIENT}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
      ),
    ).toBeInTheDocument();
  });

  it('pedido encerrado ("closed") não aparece', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'met' },
            {
              status: 'delivered',
              extension: {
                status: 'closed',
                deadlineAt: endOfBrasiliaDay(10, 9),
                reason: 'Material atrasou',
                requestedAt: '2026-10-01T12:00:00.000Z',
                resolvedAt: '2026-10-02T12:00:00.000Z',
                respondBy: null,
                seq: 1,
                deadlineZone: 'America/Sao_Paulo',
              },
            },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.queryByText(/Pedido de extensão/)).toBeNull();
    expect(screen.queryByText(/Extensão pedida/)).toBeNull();
    expect(screen.queryByText('Material atrasou')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/** Fim de 02/10/2026 em Manaus (sexta, 23:59:59 lá). */
const FIM_MANAUS = '2026-10-03T03:59:59.000Z';

/** O prazo é um dia no fuso de quem entrega (ADR 58): as duas partes leem o mesmo dia. */
describe('DeadlineSection: o dia do prazo', () => {
  it('diz o dia e "até 23:59"; quem lê no mesmo relógio não vê nota', () => {
    render(wrap(<DeadlineSection contract={contract({})} myId={CLIENT} />));
    expect(screen.getByTestId('deadline-date').textContent).toBe('sex, 02/10/2026, até 23:59');
    expect(screen.queryByTestId('deadline-zone')).toBeNull();
  });

  it.each<[string, string | null, string | null]>([
    ['Brasília', 'America/Sao_Paulo', '(horário de Manaus)'],
    ['Noronha', 'America/Noronha', '(horário de Manaus)'],
    ['sem fuso escolhido (Brasília)', null, '(horário de Manaus)'],
    ['Manaus', 'America/Manaus', null],
    ['Cuiabá (mesmo relógio de Manaus)', 'America/Cuiaba', null],
  ])('prazo de Manaus lido de %s: o mesmo dia, com a nota só em outro relógio', (_n, tz, note) => {
    auth.user = { id: CLIENT, timezone: tz };
    render(
      wrap(
        <DeadlineSection
          contract={contract({}, { deadlineAt: FIM_MANAUS, deadlineZone: 'America/Manaus' })}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.getByTestId('deadline-date').textContent).toBe('sex, 02/10/2026, até 23:59');
    expect(screen.queryByTestId('deadline-zone')?.textContent ?? null).toBe(note);
  });

  it('prazo sem o fuso (API antiga, durante o deploy) vale em Brasília, com a hora real do legado', () => {
    auth.user = { id: CLIENT, timezone: 'America/Manaus' };
    const legacy = contract({}, { deadlineAt: '2026-10-02T23:59:59.000Z' });
    delete (legacy as Partial<ContractWithHistory>).deadlineZone;
    render(wrap(<DeadlineSection contract={legacy} myId={CLIENT} />));
    expect(screen.getByTestId('deadline-date').textContent).toBe('sex, 02/10/2026, até 20:59');
    expect(screen.getByTestId('deadline-zone').textContent).toBe('(horário de Brasília)');
  });

  it('a pílula conta os dias no fuso do prazo: 22:30 em Manaus ainda é "vence hoje"', () => {
    vi.setSystemTime(new Date('2026-10-03T02:30:00Z')); // 23:30 em Brasília, 22:30 em Manaus
    render(
      wrap(
        <DeadlineSection
          contract={contract({}, { deadlineAt: FIM_MANAUS, deadlineZone: 'America/Manaus' })}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.getByTestId('deadline-state').textContent).toBe('vence hoje');
    expect(screen.getByTestId('deadline-plan')).toBeInTheDocument();
  });

  it('o pedido de extensão diz o novo dia no fuso da data pedida (aqui, o do prazo), com a nota para quem está em outro relógio', () => {
    const ext = {
      status: 'pending' as const,
      deadlineAt: '2026-10-10T03:59:59.000Z', // fim de 09/10 em Manaus
      reason: 'Material atrasou',
      requestedAt: '2026-10-01T12:00:00.000Z',
      resolvedAt: null,
      respondBy: '2026-10-03T12:00:00.000Z',
      seq: 1,
      deadlineZone: 'America/Manaus' as const,
    };
    const c = contract(
      { state: 'paused' },
      { deadlineAt: FIM_MANAUS, deadlineZone: 'America/Manaus', extension: ext },
    );
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(
      within(section()).getByText(
        'Extensão pedida: novo prazo sex, 09/10/2026, até 23:59 (horário de Manaus)',
      ),
    ).toBeInTheDocument();
    unmount();
    auth.user = { id: FREELANCER, timezone: 'America/Cuiaba' };
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { extensionRequestsLeft: 1 },
            {
              deadlineAt: FIM_MANAUS,
              deadlineZone: 'America/Manaus',
              extension: { ...ext, status: 'declined', resolvedAt: '2026-10-01T13:00:00.000Z' },
            },
          )}
          myId={FREELANCER}
        />,
      ),
    );
    expect(screen.getByTestId('extension-outcome').textContent).toBe(
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59) recusado; vale o prazo atual. Você ainda pode fazer mais um pedido.',
    );
  });

  it.each<[string, 'declined' | 'expired', string]>([
    [
      'recusado',
      'declined',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59 (horário de Manaus)) recusado; vale o prazo atual.',
    ],
    [
      'expirado',
      'expired',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59 (horário de Manaus)) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
    ],
  ])(
    'pedido %s lido de Brasília num prazo de Manaus: o novo dia vem com o horário de quem entrega',
    (_n, status, text) => {
      render(
        wrap(
          <DeadlineSection
            contract={contract(
              {},
              {
                deadlineAt: FIM_MANAUS,
                deadlineZone: 'America/Manaus',
                extension: {
                  status,
                  deadlineAt: '2026-10-10T03:59:59.000Z', // fim de 09/10 em Manaus
                  reason: 'x',
                  requestedAt: '2026-10-01T12:00:00.000Z',
                  resolvedAt: '2026-10-03T12:00:00.000Z',
                  respondBy: '2026-10-03T12:00:00.000Z',
                  seq: 1,
                  deadlineZone: 'America/Manaus',
                },
              },
            )}
            myId={CLIENT}
          />,
        ),
      );
      expect(screen.getByTestId('extension-outcome').textContent).toBe(text);
    },
  );
});

/** Revisão pedida (ADR 58, RN-081): desde quando, para as duas partes; nada muda sozinho. */
describe('DeadlineSection: revisão pedida', () => {
  const inRevision = (requestedAt: string | null, o: Partial<ContractWithHistory> = {}) =>
    contract(
      { state: 'met', firstDeliveredAt: '2026-09-25T12:00:00.000Z' },
      { status: 'revision_requested', revisionRequestedAt: requestedAt, ...o },
    );
  const since = (): string | null => screen.getByTestId('revision-since').textContent;

  it('antes dos 7 dias, o cliente lê que não há hora-limite e que o Escambo lembra os dois uma vez', () => {
    render(
      wrap(<DeadlineSection contract={inRevision('2026-09-28T13:00:00.000Z')} myId={CLIENT} />),
    );
    expect(since()).toBe(
      'Revisão pedida em seg, 28/09, às 10:00. Não há hora-limite: nada muda sozinho. Se a nova entrega não vier, combine pelo chat ou abra uma disputa pela Sala; se ela não vier em 7 dias, o Escambo lembra vocês dois, uma vez.',
    );
  });

  it('antes dos 7 dias, o freelancer lê que deve registrar a nova entrega e que o cliente pode disputar', () => {
    render(
      wrap(<DeadlineSection contract={inRevision('2026-09-28T13:00:00.000Z')} myId={FREELANCER} />),
    );
    expect(since()).toBe(
      'Revisão pedida em seg, 28/09, às 10:00: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.',
    );
  });

  it('depois dos 7 dias, as duas partes leem há quantos dias a revisão está parada', () => {
    const c = inRevision('2026-09-21T13:00:00.000Z');
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(since()).toBe(
      'Revisão pedida em seg, 21/09, às 10:00, há 10 dias, sem nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
    );
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(since()).toBe(
      'Revisão pedida em seg, 21/09, às 10:00, há 10 dias: registre a nova entrega. O cliente pode abrir uma disputa a qualquer momento.',
    );
  });

  it.each<[string, number, string, string]>([
    [
      'cliente',
      CLIENT,
      'Revisão pedida em qui, 24/09, às 12:00, há 7 dias, sem nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
      'Revisão pedida em qui, 24/09, às 12:00. Não há hora-limite: nada muda sozinho. Se a nova entrega não vier, combine pelo chat ou abra uma disputa pela Sala; se ela não vier em 7 dias, o Escambo lembra vocês dois, uma vez.',
    ],
    [
      'freelancer',
      FREELANCER,
      'Revisão pedida em qui, 24/09, às 12:00, há 7 dias: registre a nova entrega. O cliente pode abrir uma disputa a qualquer momento.',
      'Revisão pedida em qui, 24/09, às 12:00: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.',
    ],
  ])(
    '%s: a virada é aos 7 dias exatos; um segundo antes ainda é o texto de antes',
    (_n, me, atSeven, before) => {
      const { unmount } = render(
        wrap(<DeadlineSection contract={inRevision('2026-09-24T15:00:00.000Z')} myId={me} />),
      );
      expect(since()).toBe(atSeven);
      unmount();
      render(wrap(<DeadlineSection contract={inRevision('2026-09-24T15:00:01.000Z')} myId={me} />));
      expect(since()).toBe(before);
    },
  );

  it('a hora do pedido vem no fuso de quem lê', () => {
    auth.user = { id: FREELANCER, timezone: 'America/Manaus' };
    render(
      wrap(<DeadlineSection contract={inRevision('2026-09-28T13:00:00.000Z')} myId={FREELANCER} />),
    );
    expect(since()).toBe(
      'Revisão pedida em seg, 28/09, às 09:00: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.',
    );
  });

  it('fora de revisão, ou para quem não é parte, não aparece', () => {
    const { unmount } = render(
      wrap(
        <DeadlineSection
          contract={inRevision('2026-09-21T13:00:00.000Z', { status: 'delivered' })}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.queryByTestId('revision-since')).toBeNull();
    unmount();
    render(wrap(<DeadlineSection contract={inRevision('2026-09-21T13:00:00.000Z')} myId={99} />));
    expect(screen.queryByTestId('revision-since')).toBeNull();
    expect(within(section()).getByText('entregue')).toBeInTheDocument();
  });
});

/**
 * A data pedida na extensão vale até 23:59 no fuso DELA (`extension.deadlineZone`, ADR 58), que
 * pode não ser o do prazo atual; a API antiga (durante o deploy) não manda: vale o do prazo.
 */
describe('DeadlineSection: o novo prazo da extensão no fuso da data pedida', () => {
  /** Fim de 09/10/2026 em Brasília (sexta, 23:59:59 lá; 22:59:59 em Manaus). */
  const FIM_09_BRASILIA = '2026-10-10T02:59:59.000Z';
  /** Fim de 09/10/2026 em Manaus (sexta, 23:59:59 lá). */
  const FIM_09_MANAUS = '2026-10-10T03:59:59.000Z';
  type Asked = 'pending' | 'declined' | 'expired';

  const ext = (status: Asked, o: Partial<ContractExtension> = {}): ContractExtension => ({
    status,
    deadlineAt: FIM_09_BRASILIA,
    reason: 'Material atrasou',
    requestedAt: '2026-10-01T12:00:00.000Z',
    resolvedAt: status === 'pending' ? null : '2026-10-03T12:00:00.000Z',
    respondBy: '2026-10-03T12:00:00.000Z',
    seq: 1,
    deadlineZone: 'America/Sao_Paulo',
    ...o,
  });
  /** Prazo atual em Manaus; o pedido aberto pausa o prazo, o recusado ou expirado o deixa correr. */
  const manausWith = (e: ContractExtension): ContractWithHistory =>
    contract(
      { state: e.status === 'pending' ? 'paused' : 'running', extensionRequestsLeft: 0 },
      { deadlineAt: FIM_MANAUS, deadlineZone: 'America/Manaus', extension: e },
    );
  /** A linha do pedido como o cliente lê: a do pedido aberto, ou a do desfecho. */
  const askedLine = (status: Asked): string | null =>
    status === 'pending'
      ? (screen.getByTestId('extension-request').querySelector('strong')?.textContent ?? null)
      : screen.getByTestId('extension-outcome').textContent;

  it.each<[string, Asked, string]>([
    ['pedida', 'pending', 'Extensão pedida: novo prazo sex, 09/10/2026, até 23:59'],
    [
      'recusada',
      'declined',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59) recusado; vale o prazo atual.',
    ],
    [
      'expirada',
      'expired',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
    ],
  ])(
    'extensão %s com a data em Brasília num prazo de Manaus: quem lê em Brasília vê 23:59, sem nota',
    (_n, status, text) => {
      render(wrap(<DeadlineSection contract={manausWith(ext(status))} myId={CLIENT} />));
      expect(askedLine(status)).toBe(text);
      // O prazo atual continua no fuso dele.
      expect(screen.getByTestId('deadline-zone').textContent).toBe('(horário de Manaus)');
    },
  );

  it.each<[string, Asked, string]>([
    [
      'pedida',
      'pending',
      'Extensão pedida: novo prazo sex, 09/10/2026, até 23:59 (horário de Brasília)',
    ],
    [
      'recusada',
      'declined',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59 (horário de Brasília)) recusado; vale o prazo atual.',
    ],
    [
      'expirada',
      'expired',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59 (horário de Brasília)) sem resposta até sáb, 03/10, às 08:00: vale o prazo atual.',
    ],
  ])(
    'extensão %s com a data em Brasília, lida em Manaus: o dia pedido vem com o horário de Brasília',
    (_n, status, text) => {
      auth.user = { id: CLIENT, timezone: 'America/Manaus' };
      render(wrap(<DeadlineSection contract={manausWith(ext(status))} myId={CLIENT} />));
      expect(askedLine(status)).toBe(text);
      expect(screen.queryByTestId('deadline-zone')).toBeNull();
    },
  );

  it.each<[string, Asked, string]>([
    [
      'pedida',
      'pending',
      'Extensão pedida: novo prazo sex, 09/10/2026, até 23:59 (horário de Manaus)',
    ],
    [
      'recusada',
      'declined',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59 (horário de Manaus)) recusado; vale o prazo atual.',
    ],
    [
      'expirada',
      'expired',
      'Pedido de extensão (novo prazo sex, 09/10/2026, até 23:59 (horário de Manaus)) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
    ],
  ])(
    'extensão %s sem o fuso da data (API antiga, durante o deploy): vale o fuso do prazo',
    (_n, status, text) => {
      const e = ext(status, { deadlineAt: FIM_09_MANAUS });
      delete (e as Partial<ContractExtension>).deadlineZone;
      render(wrap(<DeadlineSection contract={manausWith(e)} myId={CLIENT} />));
      expect(askedLine(status)).toBe(text);
    },
  );

  it('sem fuso nem no prazo nem na extensão (API antiga): a data pedida vale em Brasília', () => {
    auth.user = { id: CLIENT, timezone: 'America/Manaus' };
    const e = ext('pending');
    delete (e as Partial<ContractExtension>).deadlineZone;
    const legacy = contract(
      { state: 'paused' },
      { deadlineAt: endOfBrasiliaDay(10, 2), extension: e },
    );
    delete (legacy as Partial<ContractWithHistory>).deadlineZone;
    render(wrap(<DeadlineSection contract={legacy} myId={CLIENT} />));
    expect(askedLine('pending')).toBe(
      'Extensão pedida: novo prazo sex, 09/10/2026, até 23:59 (horário de Brasília)',
    );
  });
});

/**
 * Revisão pedida numa contratação SEM prazo (troca, ou criada sem data): a seção do prazo não
 * aparece, mas as duas partes leem desde quando a revisão está pedida (ADR 58, RN-081). Com prazo, a
 * mesma linha fica dentro da seção do prazo, e esta não aparece.
 */
describe('RevisionSince: revisão pedida sem prazo', () => {
  const inRevision = (requestedAt: string | null, o: Partial<ContractWithHistory> = {}) =>
    contract(
      { state: 'none', extensionRequestsLeft: 0 },
      {
        deadlineAt: null,
        paymentMode: 'cash',
        status: 'revision_requested',
        revisionRequestedAt: requestedAt,
        ...o,
      },
    );
  const box = (): HTMLElement => screen.getByRole('region', { name: 'Revisão pedida' });
  const since = (): string | null => within(box()).getByTestId('revision-since').textContent;

  // Pedida há 3 dias (seg 28/09, 10:00 em Brasília) e há 10 dias (seg 21/09, 10:00).
  const RECENT = '2026-09-28T13:00:00.000Z';
  const STALLED = '2026-09-21T13:00:00.000Z';
  const CLIENT_RECENT =
    'Revisão pedida em seg, 28/09, às 10:00. Não há hora-limite: nada muda sozinho. Se a nova entrega não vier, combine pelo chat ou abra uma disputa pela Sala; se ela não vier em 7 dias, o Escambo lembra vocês dois, uma vez.';
  const FREELANCER_RECENT =
    'Revisão pedida em seg, 28/09, às 10:00: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.';
  const CLIENT_STALLED =
    'Revisão pedida em seg, 21/09, às 10:00, há 10 dias, sem nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.';
  const FREELANCER_STALLED =
    'Revisão pedida em seg, 21/09, às 10:00, há 10 dias: registre a nova entrega. O cliente pode abrir uma disputa a qualquer momento.';

  it.each<[string, Partial<ContractWithHistory>]>([
    ['em dinheiro', { paymentMode: 'cash' }],
    ['numa troca', { paymentMode: 'barter' }],
  ])(
    'antes dos 7 dias, %s: o cliente lê que nada muda sozinho; o freelancer, que registre a nova entrega',
    (_n, o) => {
      const c = inRevision(RECENT, o);
      const { unmount } = render(wrap(<RevisionSince contract={c} myId={CLIENT} />));
      expect(since()).toBe(CLIENT_RECENT);
      unmount();
      render(wrap(<RevisionSince contract={c} myId={FREELANCER} />));
      expect(since()).toBe(FREELANCER_RECENT);
    },
  );

  it.each<[string, Partial<ContractWithHistory>]>([
    ['em dinheiro', { paymentMode: 'cash' }],
    ['numa troca', { paymentMode: 'barter' }],
  ])(
    'depois dos 7 dias, %s: as duas partes leem há quantos dias a revisão está parada',
    (_n, o) => {
      const c = inRevision(STALLED, o);
      const { unmount } = render(wrap(<RevisionSince contract={c} myId={CLIENT} />));
      expect(since()).toBe(CLIENT_STALLED);
      unmount();
      render(wrap(<RevisionSince contract={c} myId={FREELANCER} />));
      expect(since()).toBe(FREELANCER_STALLED);
    },
  );

  it.each<[string, number, string, string]>([
    [
      'cliente',
      CLIENT,
      'Revisão pedida em qui, 24/09, às 12:00, há 7 dias, sem nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
      'Revisão pedida em qui, 24/09, às 12:00. Não há hora-limite: nada muda sozinho. Se a nova entrega não vier, combine pelo chat ou abra uma disputa pela Sala; se ela não vier em 7 dias, o Escambo lembra vocês dois, uma vez.',
    ],
    [
      'freelancer',
      FREELANCER,
      'Revisão pedida em qui, 24/09, às 12:00, há 7 dias: registre a nova entrega. O cliente pode abrir uma disputa a qualquer momento.',
      'Revisão pedida em qui, 24/09, às 12:00: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.',
    ],
  ])(
    'troca sem prazo, %s: a virada é aos 7 dias exatos; um segundo antes ainda é o texto de antes',
    (_n, me, atSeven, before) => {
      const barter = { paymentMode: 'barter' as const };
      const { unmount } = render(
        wrap(<RevisionSince contract={inRevision('2026-09-24T15:00:00.000Z', barter)} myId={me} />),
      );
      expect(since()).toBe(atSeven);
      unmount();
      render(
        wrap(<RevisionSince contract={inRevision('2026-09-24T15:00:01.000Z', barter)} myId={me} />),
      );
      expect(since()).toBe(before);
    },
  );

  it.each<[string, string | null, string]>([
    [
      'Manaus',
      'America/Manaus',
      'Revisão pedida em seg, 28/09, às 09:00: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.',
    ],
    ['sem fuso escolhido (Brasília)', null, FREELANCER_RECENT],
  ])('a hora do pedido vem no fuso de quem lê: %s', (_n, tz, text) => {
    auth.user = { id: FREELANCER, timezone: tz };
    render(wrap(<RevisionSince contract={inRevision(RECENT)} myId={FREELANCER} />));
    expect(since()).toBe(text);
  });

  it('com prazo, não aparece: a linha fica dentro da seção do prazo', () => {
    const withDeadline = inRevision(STALLED, {
      deadlineAt: endOfBrasiliaDay(9, 25),
      deadline: {
        state: 'met',
        noticeAt: null,
        mediationAt: null,
        extensionRequestsLeft: 0,
        undeliveredMilestones: 0,
        totalMilestones: 0,
        firstDeliveredAt: '2026-09-20T12:00:00.000Z',
      },
    });
    for (const me of [CLIENT, FREELANCER]) {
      const { unmount } = render(wrap(<RevisionSince contract={withDeadline} myId={me} />));
      expect(screen.queryByTestId('revision')).toBeNull();
      expect(screen.queryByTestId('revision-since')).toBeNull();
      unmount();
    }
  });

  it.each<[string, Partial<ContractWithHistory>]>([
    ['entregue, esperando o cliente', { status: 'delivered' }],
    ['em andamento', { status: 'in_progress' }],
    ['concluída', { status: 'completed' }],
    ['em disputa', { status: 'disputed' }],
  ])('fora de revisão (%s), não aparece para nenhuma das partes', (_n, o) => {
    const c = inRevision(STALLED, { paymentMode: 'barter', ...o });
    for (const me of [CLIENT, FREELANCER]) {
      const { unmount } = render(wrap(<RevisionSince contract={c} myId={me} />));
      expect(screen.queryByTestId('revision')).toBeNull();
      unmount();
    }
  });

  it('em revisão sem a hora do pedido (contratação antiga antes do reparo), não aparece', () => {
    const c = inRevision(null, { paymentMode: 'barter' });
    for (const me of [CLIENT, FREELANCER]) {
      const { unmount } = render(wrap(<RevisionSince contract={c} myId={me} />));
      expect(screen.queryByTestId('revision')).toBeNull();
      unmount();
    }
  });

  it('para quem não é parte da contratação, não aparece', () => {
    render(
      wrap(<RevisionSince contract={inRevision(STALLED, { paymentMode: 'barter' })} myId={99} />),
    );
    expect(screen.queryByTestId('revision')).toBeNull();
    expect(screen.queryByTestId('revision-since')).toBeNull();
  });
});
