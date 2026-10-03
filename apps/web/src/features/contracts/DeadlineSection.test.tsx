import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractDeadline, ContractWithHistory, Milestone } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { DeadlineSection } from './DeadlineSection';

const resolveExtension = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    resolveExtension: (id: number, d: string, seq?: number) => resolveExtension(id, d, seq),
    publicSettings: () => Promise.resolve({ extensionResponseHours: 48 }),
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

/** Fim do dia na hora local: a data da tela (dd/mm/aaaa) não depende do fuso de quem roda. */
const endOfLocalDay = (month: number, day: number): string =>
  new Date(2026, month - 1, day, 23, 59, 59).toISOString();

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

// O relógio da tela fica antes das horas dos exemplos (o aviso de 03/10 ainda não saiu).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T15:00:00Z'));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
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
          deadlineAt: endOfLocalDay(10, 9),
          reason: 'Material atrasou',
          requestedAt: '2026-10-01T12:00:00.000Z',
          resolvedAt: null,
          respondBy: '2026-10-03T12:00:00.000Z',
          seq: 2,
        },
      },
    );
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(within(section()).getByText('extensão pedida')).toBeInTheDocument();
    expect(
      within(section()).getByText('Extensão pedida: novo prazo 09/10/2026'),
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

  it('houve entrega: o prazo não cobra mais; em revisão, o cliente sabe que pode disputar', () => {
    const met = contract(
      { state: 'met', firstDeliveredAt: '2026-10-02T12:00:00.000Z' },
      { status: 'revision_requested' },
    );
    render(wrap(<DeadlineSection contract={met} myId={CLIENT} />));
    expect(within(section()).getByText('entregue')).toBeInTheDocument();
    expect(
      within(section()).getByText(
        'Houve entrega em sex, 02/10, às 09:00: o prazo não abre mais disputa sozinho. Se a revisão não vier, abra uma disputa pela Sala.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/venceu|vencido/)).toBeNull();
  });

  it('pedido recusado e pedido expirado aparecem com o que vale agora', () => {
    const ext = {
      deadlineAt: endOfLocalDay(10, 9),
      reason: 'x',
      requestedAt: '2026-10-01T12:00:00.000Z',
      resolvedAt: '2026-10-03T12:00:00.000Z',
      respondBy: '2026-10-03T12:00:00.000Z',
      seq: 1,
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
        'Pedido de extensão (novo prazo 09/10/2026) recusado; vale o prazo atual. Você ainda pode fazer mais um pedido.',
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
        'Pedido de extensão (novo prazo 09/10/2026) sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
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
                deadlineAt: endOfLocalDay(10, 9),
                reason: 'Material atrasou',
                requestedAt: '2026-10-01T12:00:00.000Z',
                resolvedAt: '2026-10-02T12:00:00.000Z',
                respondBy: null,
                seq: 1,
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
