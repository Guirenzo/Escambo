import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByTestId('deadline-state')).toHaveTextContent('venceu');
    expect(screen.getByTestId('deadline-late')).toHaveTextContent(
      'O prazo venceu sem entrega. O Escambo avisa vocês dois a partir de sáb, 03/10, às 09:00, e daí em diante o cliente pode cancelar com reembolso integral. Registre a entrega ou peça a extensão antes disso.',
    );
    expect(screen.getByTestId('extension-left')).toHaveTextContent(
      'até 2 pedidos; só um pode ser aceito',
    );
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(screen.getByTestId('deadline-late')).toHaveTextContent(
      'O Escambo avisa o freelancer a partir de sáb, 03/10, às 09:00; daí em diante você pode cancelar com reembolso integral, ou esperar: sem entrega, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
    );
    expect(screen.queryByText('Pedir extensão de prazo')).toBeNull();
  });

  it('carência: até quando agir; com marco entregue em aberto, sem a frase do cancelamento', () => {
    const grace = { state: 'grace' as const, extensionRequestsLeft: 1 };
    const { unmount } = render(
      wrap(<DeadlineSection contract={contract(grace)} myId={FREELANCER} />),
    );
    expect(screen.getByTestId('deadline-late')).toHaveTextContent(
      'Prazo vencido. Até dom, 04/10, às 09:00: registre a entrega ou peça a extensão, senão a disputa abre sozinha e o valor fica congelado até a decisão da mediação. O cliente já pode cancelar com reembolso integral.',
    );
    expect(screen.getByTestId('extension-left')).toHaveTextContent('resta 1 pedido');
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
    const text = screen.getByTestId('deadline-late').textContent ?? '';
    expect(text).toMatch(/^Faltam 1 de 2 marcos\. Prazo vencido\. Sem as entregas que faltam/);
    expect(text).not.toContain('sem entrega');
    expect(text).not.toContain('cancelar');
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
    expect(screen.getByTestId('deadline-late')).toHaveTextContent(
      'O prazo venceu com um marco por entregar. O Escambo avisa o freelancer a partir de sáb, 03/10, às 09:00: sem as entregas que faltam, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
    );
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    const f = screen.getByTestId('deadline-late').textContent ?? '';
    expect(f).not.toContain('cancelar');
    expect(f).toContain('Entregue o marco que falta ou peça a extensão antes disso.');
  });

  it('aviso projetado já no passado (job atrasado): "a qualquer momento" e o cancelamento já vale', () => {
    const c = contract({ state: 'due', noticeAt: '2026-10-01T12:00:00.000Z' });
    const { unmount } = render(wrap(<DeadlineSection contract={c} myId={FREELANCER} />));
    expect(screen.getByTestId('deadline-late')).toHaveTextContent(
      'O prazo venceu sem entrega. O Escambo avisa vocês dois a qualquer momento, e o cliente já pode cancelar com reembolso integral. Registre a entrega ou peça a extensão.',
    );
    unmount();
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(screen.getByTestId('deadline-late')).toHaveTextContent(
      'O prazo venceu sem entrega. Você já pode cancelar com reembolso integral, ou esperar: sem entrega, a disputa abre sozinha a partir de dom, 04/10, às 09:00.',
    );
  });

  it('pedido de extensão: o cliente vê até quando responder e decide o pedido que viu', async () => {
    const user = userEvent.setup();
    const c = contract(
      { state: 'paused' },
      {
        deadlineAt: '2025-12-01T02:59:59.000Z', // já vencido pelo relógio real
        extension: {
          status: 'pending',
          deadlineAt: '2026-10-10T02:59:59.000Z',
          reason: 'Material atrasou',
          requestedAt: '2026-10-01T12:00:00.000Z',
          resolvedAt: null,
          respondBy: '2026-10-03T12:00:00.000Z',
          seq: 2,
        },
      },
    );
    render(wrap(<DeadlineSection contract={c} myId={CLIENT} />));
    expect(screen.getByTestId('deadline-state')).toHaveTextContent('extensão pedida');
    expect(screen.getByTestId('extension-respond-by')).toHaveTextContent(
      'Responda até sáb, 03/10, às 09:00. Sem resposta, o pedido expira e vale o prazo atual. Enquanto você decide, a disputa automática espera.',
    );
    await user.click(screen.getByRole('button', { name: /Recusar/ }));
    expect(resolveExtension).toHaveBeenCalledWith(9, 'decline', 2);
    expect(await screen.findByText('Extensão recusada; vale o prazo atual.')).toBeInTheDocument();
  });

  it('houve entrega: o prazo não cobra mais; em revisão, o cliente sabe que pode disputar', () => {
    const met = contract(
      { state: 'met', firstDeliveredAt: '2026-10-02T12:00:00.000Z' },
      { status: 'revision_requested' },
    );
    render(wrap(<DeadlineSection contract={met} myId={CLIENT} />));
    expect(screen.getByTestId('deadline-met')).toHaveTextContent(
      'Houve entrega em sex, 02/10, às 09:00: o prazo não abre mais disputa sozinho. Se a revisão não vier, abra uma disputa pela Sala.',
    );
    expect(screen.queryByTestId('deadline-late')).toBeNull();
  });

  it('pedido recusado e pedido expirado aparecem com o que vale agora', () => {
    const ext = {
      deadlineAt: '2026-10-10T02:59:59.000Z',
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
    expect(screen.getByTestId('extension-outcome')).toHaveTextContent(
      'recusado; vale o prazo atual. Você ainda pode fazer mais um pedido.',
    );
    unmount();
    render(
      wrap(
        <DeadlineSection
          contract={contract({}, { extension: { ...ext, status: 'expired' } })}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.getByTestId('extension-outcome')).toHaveTextContent(
      'sem resposta até sáb, 03/10, às 09:00: vale o prazo atual.',
    );
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
                deadlineAt: '2026-10-10T02:59:59.000Z',
                reason: 'x',
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
    expect(screen.queryByTestId('extension-outcome')).toBeNull();
    expect(screen.queryByTestId('extension-request')).toBeNull();
  });
});
