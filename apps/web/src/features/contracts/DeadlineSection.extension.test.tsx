import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
import { DeadlineSection } from './DeadlineSection';

/**
 * O que o DeadlineSection.test.tsx não cobre (RN-028 / ADR 57): o pedido de extensão do
 * freelancer (o modal), o aceite do cliente, as recusas da API e os textos dos estados que
 * sobraram (prazo correndo, sem pedidos restantes, vários marcos por entregar, quem só assiste).
 */

const requestExtension = vi.fn();
const resolveExtension = vi.fn();
const publicSettings = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    requestExtension: (id: number, body: unknown) => requestExtension(id, body),
    resolveExtension: (id: number, d: string, seq?: number) => resolveExtension(id, d, seq),
    publicSettings: () => publicSettings(),
  },
}));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 1, timezone: 'America/Sao_Paulo' } }),
}));

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

/** Dias montados na hora local: datas e campos de data não dependem do fuso de quem roda. */
const local = (month: number, day: number, hour = 23, minute = 59, second = 59): string =>
  new Date(2026, month - 1, day, hour, minute, second).toISOString();

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
    deadlineAt: local(9, 30),
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

const pending = (o: Partial<ContractExtension> = {}): ContractExtension => ({
  status: 'pending',
  deadlineAt: local(10, 10),
  reason: 'Material atrasou',
  requestedAt: '2026-10-01T12:00:00.000Z',
  resolvedAt: null,
  respondBy: '2026-10-03T12:00:00.000Z',
  seq: 2,
  ...o,
});

const section = (): HTMLElement => screen.getByRole('region', { name: 'Prazo de entrega' });

// Agora: 01/10/2026, meio-dia local. O prazo padrão dos exemplos (30/09) já venceu.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  requestExtension.mockReset();
  requestExtension.mockResolvedValue(contract({ state: 'paused' }, { extension: pending() }));
  resolveExtension.mockReset();
  resolveExtension.mockResolvedValue({});
  publicSettings.mockReset();
  publicSettings.mockResolvedValue({ extensionResponseHours: 72 });
});

describe('DeadlineSection: prazo correndo e contratação sem prazo', () => {
  it('sem prazo combinado, a seção não aparece', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'none' }, { deadlineAt: null })}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.queryByRole('region', { name: 'Prazo de entrega' })).toBeNull();
  });

  it('a até 3 dias do prazo, diz quando sai o aviso e a partir de quando a disputa abre sozinha', () => {
    render(
      wrap(<DeadlineSection contract={contract({}, { deadlineAt: local(10, 3) })} myId={CLIENT} />),
    );
    expect(within(section()).getByText('03/10/2026')).toBeInTheDocument();
    expect(within(section()).getByText('faltam 2 dias')).toBeInTheDocument();
    expect(
      within(section())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Se não houver entrega: aviso às duas partes sáb, 03/10, às 09:00',
      'Disputa automática: a partir de dom, 04/10, às 09:00',
    ]);
    // Correndo, ninguém lê aviso de atraso.
    expect(screen.queryByText(/venceu/)).toBeNull();
  });

  it('com mais de 3 dias pela frente, só a data e quanto falta', () => {
    render(
      wrap(
        <DeadlineSection contract={contract({}, { deadlineAt: local(10, 10) })} myId={CLIENT} />,
      ),
    );
    expect(within(section()).getByText('10/10/2026')).toBeInTheDocument();
    expect(within(section()).getByText('faltam 9 dias')).toBeInTheDocument();
    expect(within(section()).queryAllByRole('listitem')).toEqual([]);
  });

  it('o plano do atraso aparece a exatamente 3 dias do prazo e some a 4', () => {
    const { unmount } = render(
      wrap(
        <DeadlineSection contract={contract({}, { deadlineAt: local(10, 4) })} myId={FREELANCER} />,
      ),
    );
    expect(within(section()).getByText('faltam 3 dias')).toBeInTheDocument();
    expect(within(section()).getAllByRole('listitem')).toHaveLength(2);
    unmount();
    render(
      wrap(
        <DeadlineSection contract={contract({}, { deadlineAt: local(10, 5) })} myId={FREELANCER} />,
      ),
    );
    expect(within(section()).getByText('faltam 4 dias')).toBeInTheDocument();
    expect(within(section()).queryAllByRole('listitem')).toEqual([]);
  });

  it.each<[string, Partial<ContractDeadline>]>([
    ['a hora do aviso', { noticeAt: null }],
    ['a hora da disputa', { mediationAt: null }],
  ])('sem %s calculada, o plano do atraso não aparece pela metade', (_name, deadline) => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(deadline, { deadlineAt: local(10, 3) })}
          myId={CLIENT}
        />,
      ),
    );
    expect(within(section()).getByText('faltam 2 dias')).toBeInTheDocument();
    expect(within(section()).queryAllByRole('listitem')).toEqual([]);
    expect(screen.queryByText(/Disputa automática/)).toBeNull();
  });

  it('prazo sem extensão não fala em "estendido"', () => {
    render(
      wrap(
        <DeadlineSection contract={contract({}, { deadlineAt: local(10, 10) })} myId={CLIENT} />,
      ),
    );
    expect(screen.queryByText(/estendido em/)).toBeNull();
  });

  it('com o prazo correndo, o freelancer já pode pedir extensão; o cliente não vê o botão', () => {
    const c = contract({}, { deadlineAt: local(10, 10) });
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(screen.getByRole('button', { name: 'Pedir extensão de prazo' })).toBeEnabled();
    expect(within(section()).getByText('até 2 pedidos; só um pode ser aceito')).toBeInTheDocument();
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('até 2 pedidos; só um pode ser aceito')).toBeNull();
  });

  it('prazo que já foi estendido diz quando e que a extensão foi usada', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { extensionRequestsLeft: 0 },
            { deadlineAt: local(10, 10), deadlineExtendedAt: local(9, 28, 10, 0, 0) },
          )}
          myId={FREELANCER}
        />,
      ),
    );
    expect(
      within(section()).getByText('estendido em 28/09/2026 · extensão usada'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir extensão de prazo' })).toBeNull();
  });
});

describe('DeadlineSection: prazo vencido, os textos que faltavam', () => {
  it('carência, cliente, entrega única: pode cancelar com reembolso integral ou esperar a mediação', () => {
    render(wrap(<DeadlineSection contract={contract({ state: 'grace' })} myId={CLIENT} />));
    expect(within(section()).getByText('vencido')).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'Prazo vencido sem entrega. Você pode cancelar com reembolso integral, ou esperar: sem entrega nem extensão aceita até dom, 04/10, às 09:00, a disputa abre sozinha e a mediação do Escambo decide.',
      ),
    ).toBeInTheDocument();
  });

  it('freelancer sem pedidos restantes e com vários marcos por entregar: a frase não oferece extensão, e o botão some', () => {
    const c = contract(
      { state: 'grace', extensionRequestsLeft: 0, undeliveredMilestones: 2, totalMilestones: 3 },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'delivered', deliveredAt: '2026-09-29T12:00:00.000Z' },
          { id: 2, status: 'funded', deliveredAt: null },
          { id: 3, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    // Marco entregue em aberto trava o cancelamento: a frase também não o oferece ao cliente.
    expect(
      within(section()).getByText(
        'Prazo vencido. Até dom, 04/10, às 09:00: entregue os 2 marcos que faltam, senão a disputa abre sozinha e o valor fica congelado até a decisão da mediação.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir extensão de prazo' })).toBeNull();
    expect(screen.queryByText('resta 1 pedido')).toBeNull();
  });

  it('vencido com vários marcos por entregar e o aviso já devido: o cliente lê só quando a disputa abre', () => {
    const c = contract(
      {
        state: 'due',
        noticeAt: '2026-10-01T09:00:00.000Z',
        undeliveredMilestones: 2,
        totalMilestones: 3,
      },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'funded', deliveredAt: '2026-09-29T12:00:00.000Z' },
          { id: 2, status: 'funded', deliveredAt: null },
          { id: 3, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(within(section()).getByText('venceu')).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'O prazo venceu com 2 marcos por entregar. Sem as entregas que faltam, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
      ),
    ).toBeInTheDocument();
  });

  it('marco já liberado não trava o cancelamento: com parte entregue e aprovada, o cliente ainda lê a oferta', () => {
    const c = contract(
      { state: 'grace', undeliveredMilestones: 1, totalMilestones: 2 },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'released', deliveredAt: '2026-09-25T12:00:00.000Z' },
          { id: 2, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(
      within(section()).getByText(
        'Faltam 1 de 2 marcos. Prazo vencido. Você pode cancelar com reembolso integral, ou esperar: sem as entregas que faltam nem extensão aceita até dom, 04/10, às 09:00, a disputa abre sozinha e a mediação do Escambo decide.',
      ),
    ).toBeInTheDocument();
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(
      within(section()).getByText(
        'Prazo vencido. Até dom, 04/10, às 09:00: entregue o marco que falta ou peça a extensão, senão a disputa abre sozinha e o valor fica congelado até a decisão da mediação. O cliente já pode cancelar com reembolso integral.',
      ),
    ).toBeInTheDocument();
  });

  it('por marcos sem nenhum entregue: vale o texto de "sem entrega", não o de "faltam N de M"', () => {
    const c = contract(
      { state: 'grace', undeliveredMilestones: 2, totalMilestones: 2 },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'funded', deliveredAt: null },
          { id: 2, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(
      within(section()).getByText(
        'Prazo vencido sem entrega. Você pode cancelar com reembolso integral, ou esperar: sem entrega nem extensão aceita até dom, 04/10, às 09:00, a disputa abre sozinha e a mediação do Escambo decide.',
      ),
    ).toBeInTheDocument();
    unmount();

    render(
      wrap(
        <DeadlineSection
          contract={{ ...c, deadline: { ...c.deadline, state: 'due' } }}
          myId={FREELANCER}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'O prazo venceu sem entrega. O Escambo avisa vocês dois a partir de sáb, 03/10, às 09:00, e daí em diante o cliente pode cancelar com reembolso integral. Entregue os 2 marcos que faltam ou peça a extensão antes disso.',
      ),
    ).toBeInTheDocument();
  });

  it('vencido com o aviso já devido e marco entregue em aberto: o freelancer não lê oferta de cancelamento nem "antes disso"', () => {
    const c = contract(
      {
        state: 'due',
        noticeAt: '2026-10-01T09:00:00.000Z',
        extensionRequestsLeft: 0,
        undeliveredMilestones: 1,
        totalMilestones: 2,
      },
      {
        hasMilestones: true,
        milestones: [
          { id: 1, status: 'delivered', deliveredAt: '2026-09-29T12:00:00.000Z' },
          { id: 2, status: 'funded', deliveredAt: null },
        ] as unknown as Milestone[],
      },
    );
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(
      within(section()).getByText(
        'O prazo venceu com um marco por entregar. O Escambo avisa vocês dois a qualquer momento. Entregue o marco que falta.',
      ),
    ).toBeInTheDocument();
  });

  it('quem não é parte da contratação vê o prazo, mas não o aviso de atraso nem o pedido de extensão', () => {
    render(wrap(<DeadlineSection contract={contract({ state: 'due' })} myId={99} />));
    expect(within(section()).getByText('30/09/2026')).toBeInTheDocument();
    expect(within(section()).getByText('venceu')).toBeInTheDocument();
    expect(screen.queryByText(/O prazo venceu sem entrega/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('DeadlineSection: depois da entrega', () => {
  it('por marcos, todos entregues: cada marco segue a própria aprovação', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'met' }, { hasMilestones: true })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(within(section()).getByText('entregue')).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'Todos os marcos foram entregues: o prazo não abre mais disputa sozinho; cada marco segue a própria aprovação.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir extensão de prazo' })).toBeNull();
  });

  it('entrega única sem a hora gravada, lida pelo freelancer: sem data e sem a dica da disputa', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'met' }, { status: 'revision_requested' })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(
      within(section()).getByText('Houve entrega: o prazo não abre mais disputa sozinho.'),
    ).toBeInTheDocument();
  });

  it('entregue e esperando o cliente: ele lê quando foi a entrega, sem a dica da disputa (ela é só da revisão)', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'met', firstDeliveredAt: '2026-09-30T12:00:00.000Z' },
            { status: 'delivered' },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Houve entrega em qua, 30/09, às 09:00: o prazo não abre mais disputa sozinho.',
      ),
    ).toBeInTheDocument();
    // Depois da entrega ninguém lê aviso de atraso nem plano de disputa automática.
    expect(screen.queryByText(/venceu|vencido/i)).toBeNull();
    expect(within(section()).queryAllByRole('listitem')).toEqual([]);
  });

  it.each<[string, 'declined' | 'expired']>([
    ['recusado', 'declined'],
    ['expirado', 'expired'],
  ])('depois da entrega, um pedido de extensão %s não aparece mais', (_name, status) => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'met', extensionRequestsLeft: 1 },
            {
              status: 'delivered',
              extension: pending({ status, resolvedAt: '2026-09-29T12:00:00.000Z' }),
            },
          )}
          myId={FREELANCER}
        />,
      ),
    );
    expect(within(section()).getByText('entregue')).toBeInTheDocument();
    expect(screen.queryByText(/Pedido de extensão/)).toBeNull();
    expect(screen.queryByText(/mais um pedido/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pedir extensão de prazo' })).toBeNull();
  });
});

describe('DeadlineSection: pedido de extensão esperando o cliente', () => {
  it('o freelancer vê o pedido, o motivo e até quando o cliente responde, sem botões de decisão', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(within(section()).getByText('extensão pedida')).toBeInTheDocument();
    expect(
      within(section()).getByText('Extensão pedida: novo prazo 10/10/2026'),
    ).toBeInTheDocument();
    expect(within(section()).getByText('Material atrasou')).toBeInTheDocument();
    expect(
      within(section()).getByText('aguardando o cliente até sáb, 03/10, às 09:00'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Responda até/)).toBeNull();
  });

  it('sem hora-limite gravada, o freelancer lê só "aguardando o cliente"', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending({ respondBy: null }) })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(within(section()).getByText('aguardando o cliente')).toBeInTheDocument();
  });

  it('com o prazo ainda por vencer, o cliente não lê que a disputa automática espera', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'paused' },
            { deadlineAt: local(10, 5), extension: pending() },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Responda até sáb, 03/10, às 09:00. Sem resposta, o pedido expira e vale o prazo atual.',
      ),
    ).toBeInTheDocument();
  });

  it('sem hora-limite gravada, o cliente decide do mesmo jeito, só não lê "Responda até"', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending({ respondBy: null }) })}
          myId={CLIENT}
        />,
      ),
    );
    expect(
      within(section()).getByText('Extensão pedida: novo prazo 10/10/2026'),
    ).toBeInTheDocument();
    expect(within(section()).getByText('Material atrasou')).toBeInTheDocument();
    expect(screen.queryByText(/Responda até/)).toBeNull();
    expect(screen.queryByText(/aguardando o cliente/)).toBeNull();
    expect(
      within(section())
        .getAllByRole('button')
        .map((b) => (b.textContent ?? '').trim()),
    ).toEqual(['Aceitar novo prazo', 'Recusar']);
  });

  it('quem só assiste (não é parte) vê o pedido, mas não decide', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={99}
        />,
      ),
    );
    expect(
      within(section()).getByText('Extensão pedida: novo prazo 10/10/2026'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Responda até/)).toBeNull();
  });

  it('enquanto o cliente decide, o aviso de atraso não aparece (a disputa automática espera)', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(screen.queryByText(/Prazo vencido|O prazo venceu/)).toBeNull();
  });

  it('o cliente recusa: decide o pedido que viu e lê que vale o prazo atual', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending({ seq: 1 }) })}
          myId={CLIENT}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(resolveExtension).toHaveBeenCalledTimes(1);
    expect(resolveExtension).toHaveBeenCalledWith(9, 'decline', 1);
    expect(await screen.findByText('Extensão recusada; vale o prazo atual.')).toBeInTheDocument();
    expect(screen.queryByText('Prazo estendido. O freelancer foi avisado.')).toBeNull();
  });

  it('o cliente aceita: decide o pedido que viu (seq) e lê que o freelancer foi avisado', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={CLIENT}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Aceitar novo prazo' }));
    expect(resolveExtension).toHaveBeenCalledTimes(1);
    expect(resolveExtension).toHaveBeenCalledWith(9, 'accept', 2);
    expect(
      await screen.findByText('Prazo estendido. O freelancer foi avisado.'),
    ).toBeInTheDocument();
  });

  it('a API recusa a decisão (pedido trocado): o aviso é a mensagem dela, sem aviso de sucesso', async () => {
    const user = userEvent.setup();
    resolveExtension.mockRejectedValue(new Error('O pedido mudou: confira o novo prazo.'));
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={CLIENT}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Aceitar novo prazo' }));
    expect(await screen.findByText('O pedido mudou: confira o novo prazo.')).toBeInTheDocument();
    expect(screen.queryByText('Prazo estendido. O freelancer foi avisado.')).toBeNull();
  });

  it('decisão que falha sem mensagem: "Não foi possível responder"', async () => {
    const user = userEvent.setup();
    resolveExtension.mockRejectedValue('offline');
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={CLIENT}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(resolveExtension).toHaveBeenCalledWith(9, 'decline', 2);
    expect(await screen.findByText('Não foi possível responder')).toBeInTheDocument();
  });

  it('enquanto a decisão está em curso, aceitar e recusar ficam desabilitados', async () => {
    const user = userEvent.setup();
    let release!: (v: unknown) => void;
    resolveExtension.mockReturnValue(new Promise((r) => (release = r)));
    render(
      wrap(
        <DeadlineSection
          contract={contract({ state: 'paused' }, { extension: pending() })}
          myId={CLIENT}
        />,
      ),
    );
    const accept = screen.getByRole('button', { name: 'Aceitar novo prazo' });
    const decline = screen.getByRole('button', { name: 'Recusar' });
    await user.click(accept);
    await waitFor(() => expect(accept).toBeDisabled());
    expect(decline).toBeDisabled();
    // O aviso de sucesso só sai quando a API responde.
    expect(screen.queryByText('Prazo estendido. O freelancer foi avisado.')).toBeNull();
    release({});
    expect(
      await screen.findByText('Prazo estendido. O freelancer foi avisado.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(accept).toBeEnabled());
    expect(decline).toBeEnabled();
    expect(resolveExtension).toHaveBeenCalledTimes(1);
  });

  it.each<[string, 'declined' | 'expired', string]>([
    [
      'recusado',
      'declined',
      'Pedido de extensão (novo prazo 10/10/2026) recusado; vale o prazo atual.',
    ],
    [
      'expirado',
      'expired',
      'Pedido de extensão (novo prazo 10/10/2026) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
    ],
  ])(
    'segundo pedido %s: o freelancer não lê "mais um pedido" nem vê o botão de pedir',
    (_name, status, text) => {
      render(
        wrap(
          <DeadlineSection
            contract={contract(
              { state: 'grace', extensionRequestsLeft: 0 },
              { extension: pending({ status, resolvedAt: '2026-10-03T12:00:00.000Z' }) },
            )}
            myId={FREELANCER}
          />,
        ),
      );
      expect(within(section()).getByText(text)).toBeInTheDocument();
      expect(screen.queryByText(/mais um pedido/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pedir extensão de prazo' })).toBeNull();
    },
  );

  it('primeiro pedido recusado: o freelancer lê que ainda cabe um e o botão continua lá', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'grace', extensionRequestsLeft: 1 },
            { extension: pending({ status: 'declined', seq: 1 }) },
          )}
          myId={FREELANCER}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Pedido de extensão (novo prazo 10/10/2026) recusado; vale o prazo atual. Você ainda pode fazer mais um pedido.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pedir extensão de prazo' })).toBeEnabled();
    expect(within(section()).getByText('resta 1 pedido')).toBeInTheDocument();
  });

  it('pedido expirado, lido pelo cliente: sem a frase do "mais um pedido"', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'due', extensionRequestsLeft: 1 },
            { extension: pending({ status: 'expired', resolvedAt: '2026-10-03T12:00:00.000Z' }) },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Pedido de extensão (novo prazo 10/10/2026) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
      ),
    ).toBeInTheDocument();
  });

  it('pedido expirado sem hora-limite gravada: vale a hora em que foi encerrado; o freelancer sabe que ainda cabe um', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'due', extensionRequestsLeft: 1 },
            {
              extension: pending({
                status: 'expired',
                respondBy: null,
                resolvedAt: '2026-10-04T12:00:00.000Z',
              }),
            },
          )}
          myId={FREELANCER}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Pedido de extensão (novo prazo 10/10/2026) sem resposta até dom, 04/10, às 09:00: vale o prazo atual. Você ainda pode fazer mais um pedido.',
      ),
    ).toBeInTheDocument();
    expect(within(section()).getByText('resta 1 pedido')).toBeInTheDocument();
  });

  it('pedido recusado, lido pelo cliente: sem a frase do "mais um pedido"', () => {
    render(
      wrap(
        <DeadlineSection
          contract={contract(
            { state: 'due', extensionRequestsLeft: 1 },
            { extension: pending({ status: 'declined', resolvedAt: '2026-10-01T13:00:00.000Z' }) },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(
      within(section()).getByText(
        'Pedido de extensão (novo prazo 10/10/2026) recusado; vale o prazo atual.',
      ),
    ).toBeInTheDocument();
  });
});

describe('DeadlineSection: o freelancer pede a extensão', () => {
  const open = async (c: ContractWithHistory) => {
    const user = userEvent.setup();
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    await user.click(screen.getByRole('button', { name: 'Pedir extensão de prazo' }));
    return { user, dialog: screen.getByRole('dialog', { name: 'Pedir extensão de prazo' }) };
  };

  it('o modal diz o prazo atual, quantos pedidos restam e as horas que o cliente tem (configuração do servidor)', async () => {
    const { dialog } = await open(contract({ state: 'due', extensionRequestsLeft: 1 }));
    expect(
      await within(dialog).findByText(
        'Prazo atual: 30/09/2026. Você pode pedir até 2 vezes nesta contratação (resta 1), e só uma extensão pode ser aceita. O cliente tem até 72 h para responder; sem resposta, o pedido expira. Enquanto ele decide, a disputa automática espera.',
      ),
    ).toBeInTheDocument();
  });

  it('enquanto a configuração não chega, vale o padrão de 48 h; quando chega, vale a do servidor', async () => {
    let arrive!: (s: { extensionResponseHours: number }) => void;
    publicSettings.mockReturnValue(new Promise((r) => (arrive = r)));
    const { dialog } = await open(contract({ state: 'due' }));
    expect(within(dialog).getByText(/O cliente tem até 48 h para responder/)).toBeInTheDocument();
    arrive({ extensionResponseHours: 72 });
    expect(
      await within(dialog).findByText(/O cliente tem até 72 h para responder/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/48 h/)).toBeNull();
  });

  it('prazo já vencido: o novo prazo começa amanhã e vem sugerido para uma semana depois de hoje', async () => {
    const { dialog } = await open(contract({ state: 'due' }));
    const date = within(dialog).getByLabelText('Novo prazo (vale até 23:59 do dia)');
    expect(date).toHaveAttribute('min', '2026-10-02');
    expect(date).toHaveValue('2026-10-08');
    expect(date).toBeRequired();
  });

  it('prazo ainda por vencer: o novo prazo tem de ser depois do atual', async () => {
    const { dialog } = await open(contract({}, { deadlineAt: local(10, 5) }));
    const date = within(dialog).getByLabelText('Novo prazo (vale até 23:59 do dia)');
    expect(date).toHaveAttribute('min', '2026-10-06');
    expect(date).toHaveValue('2026-10-12');
  });

  it('só envia com motivo de pelo menos 5 caracteres (espaços não contam)', async () => {
    const { user, dialog } = await open(contract({ state: 'due' }));
    const submit = within(dialog).getByRole('button', { name: 'Enviar pedido' });
    const reason = within(dialog).getByLabelText('Motivo (o cliente lê)');
    // O navegador também barra: obrigatório, de 5 a 500 caracteres.
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('minlength', '5');
    expect(reason).toHaveAttribute('maxlength', '500');
    expect(submit).toBeDisabled();
    await user.type(reason, '  ok   ');
    expect(submit).toBeDisabled();
    await user.type(reason, 'tudo');
    expect(submit).toBeEnabled();
    expect(requestExtension).not.toHaveBeenCalled();
  });

  it('envia o fim do dia escolhido e o motivo sem espaços nas pontas; avisa até quando o cliente responde e fecha', async () => {
    const { user, dialog } = await open(contract({ state: 'due' }));
    const date = within(dialog).getByLabelText('Novo prazo (vale até 23:59 do dia)');
    await user.clear(date);
    await user.type(date, '2026-10-15');
    await user.type(
      within(dialog).getByLabelText('Motivo (o cliente lê)'),
      '  O material chegou 3 dias depois  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    expect(requestExtension).toHaveBeenCalledTimes(1);
    // O prazo vale o dia inteiro: 23:59:59 do dia escolhido, na hora local de quem pede.
    expect(requestExtension).toHaveBeenCalledWith(9, {
      deadlineAt: local(10, 15),
      reason: 'O material chegou 3 dias depois',
    });
    expect(
      await screen.findByText(
        'Pedido enviado. O cliente tem até sáb, 03/10, às 09:00 para responder.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sem trocar a data, vai a sugerida', async () => {
    const { user, dialog } = await open(contract({ state: 'due' }));
    await user.type(within(dialog).getByLabelText('Motivo (o cliente lê)'), 'Material atrasou');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(requestExtension).toHaveBeenCalledWith(9, {
      deadlineAt: local(10, 8),
      reason: 'Material atrasou',
    });
  });

  it('resposta sem hora-limite: o aviso diz que o cliente decide pela Sala', async () => {
    requestExtension.mockResolvedValue(contract({ state: 'paused' }, { extension: null }));
    const { user, dialog } = await open(contract({ state: 'due' }));
    await user.type(within(dialog).getByLabelText('Motivo (o cliente lê)'), 'Material atrasou');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(
      await screen.findByText('Pedido enviado. O cliente decide pela Sala.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a API recusa o pedido: mostra a mensagem dela e o modal continua aberto com o motivo digitado', async () => {
    requestExtension.mockRejectedValue(new Error('O novo prazo precisa ser depois do atual.'));
    const { user, dialog } = await open(contract({ state: 'due' }));
    const reason = within(dialog).getByLabelText('Motivo (o cliente lê)');
    await user.type(reason, 'Material atrasou');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(
      await screen.findByText('O novo prazo precisa ser depois do atual.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Pedir extensão de prazo' })).toBeInTheDocument();
    expect(reason).toHaveValue('Material atrasou');
    expect(screen.queryByText(/^Pedido enviado/)).toBeNull();
  });

  it('pedido que falha sem mensagem: "Não foi possível pedir a extensão"', async () => {
    requestExtension.mockRejectedValue('offline');
    const { user, dialog } = await open(contract({ state: 'due' }));
    await user.type(within(dialog).getByLabelText('Motivo (o cliente lê)'), 'Material atrasou');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(await screen.findByText('Não foi possível pedir a extensão')).toBeInTheDocument();
  });

  it('enquanto envia, o botão diz "Enviando…" e não aceita outro envio', async () => {
    let release!: (c: ContractWithHistory) => void;
    requestExtension.mockReturnValue(new Promise<ContractWithHistory>((r) => (release = r)));
    const { user, dialog } = await open(contract({ state: 'due' }));
    await user.type(within(dialog).getByLabelText('Motivo (o cliente lê)'), 'Material atrasou');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    expect(await within(dialog).findByRole('button', { name: 'Enviando…' })).toBeDisabled();
    release(contract({ state: 'paused' }, { extension: pending() }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requestExtension).toHaveBeenCalledTimes(1);
  });

  it('o ✕ fecha o modal sem pedir nada', async () => {
    const { user, dialog } = await open(contract({ state: 'due' }));
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestExtension).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pedir extensão de prazo' })).toBeInTheDocument();
  });
});
