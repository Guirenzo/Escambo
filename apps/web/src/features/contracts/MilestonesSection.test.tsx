import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractWithHistory, Milestone } from '@escambo/types';
import type { ReactNode } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { MilestonesSection } from './MilestonesSection';

/**
 * Escrow por marcos (RN-069) na Sala: o que já foi liberado, a situação de cada marco e as ações
 * de cada lado — o freelancer entrega marco a marco, o cliente aprova (libera só aquele valor) ou
 * pede revisão.
 */

const milestoneAction = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    milestoneAction: (contractId: number, milestoneId: number, action: string, text?: string) =>
      milestoneAction(contractId, milestoneId, action, text),
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

/** Datas montadas na hora local: o texto da tela não depende do fuso de quem roda o teste. */
const local = (month: number, day: number, hour = 12, minute = 0, second = 0): string =>
  new Date(2026, month - 1, day, hour, minute, second).toISOString();

const milestone = (o: Partial<Milestone> = {}): Milestone => ({
  id: 1,
  title: 'Roteiro',
  description: null,
  amount: 100,
  freelancerNet: 85,
  sortOrder: 0,
  status: 'funded',
  dueAt: null,
  deliveredAt: null,
  deliveryNote: null,
  revisionNote: null,
  releasedAt: null,
  approvalDueAt: null,
  ...o,
});

const contract = (
  milestones: Milestone[],
  o: Partial<ContractWithHistory> = {},
): ContractWithHistory =>
  ({
    id: 9,
    clientId: CLIENT,
    freelancerId: FREELANCER,
    title: 'Vídeo',
    status: 'in_progress',
    paymentMode: 'cash',
    price: 300,
    hasMilestones: true,
    milestones,
    ...o,
  }) as ContractWithHistory;

/** Roteiro liberado, Gravação entregue (esperando o cliente), Edição ainda por entregar. */
const three = (): Milestone[] => [
  milestone({
    id: 1,
    title: 'Roteiro',
    description: 'Texto e storyboard',
    status: 'released',
    dueAt: local(9, 20, 23, 59, 59),
    deliveredAt: local(9, 22, 10, 0),
    deliveryNote: 'Roteiro no Drive',
    releasedAt: local(9, 23, 9, 15),
  }),
  milestone({
    id: 2,
    title: 'Gravação',
    status: 'delivered',
    dueAt: local(10, 5, 23, 59, 59),
    deliveredAt: local(9, 30, 18, 0),
    deliveryNote: 'Vídeo bruto enviado',
    approvalDueAt: '2026-10-03T12:00:00.000Z',
  }),
  milestone({ id: 3, title: 'Edição', status: 'funded', dueAt: local(10, 4, 23, 59, 59) }),
];

const items = (): HTMLElement[] => screen.getAllByRole('listitem');
const item = (i: number): HTMLElement => items()[i]!;

let prompt: MockInstance<typeof window.prompt>;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 1, 12, 0, 0));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  milestoneAction.mockReset();
  milestoneAction.mockImplementation(async () => contract(three()));
  prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
});
afterEach(() => prompt.mockRestore());

describe('MilestonesSection: o que a lista mostra', () => {
  it('contratação sem marcos: a seção não aparece', () => {
    render(wrap(<MilestonesSection contract={contract([])} myId={CLIENT} />));
    expect(screen.queryByRole('region', { name: 'Marcos' })).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('o cabeçalho soma o que já foi liberado e a barra mostra a fração do total', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    const section = screen.getByRole('region', { name: 'Marcos' });
    expect(
      within(section).getByText('1 de 3 liberados · R$ 100,00 de R$ 300,00'),
    ).toBeInTheDocument();
    const bar = within(section).getByRole('progressbar', { name: 'Progresso dos marcos' });
    expect(bar).toHaveAttribute('aria-valuenow', '33');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('cada marco vem na ordem, com título, valor e situação', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            ...three(),
            milestone({ id: 4, title: 'Legendas', status: 'cancelled', amount: 50 }),
            milestone({ id: 5, title: 'Trilha', status: 'pending', amount: 25.5 }),
          ])}
          myId={CLIENT}
        />,
      ),
    );
    expect(items()).toHaveLength(5);
    expect(item(0)).toHaveTextContent(/^1Roteiro/);
    expect(within(item(0)).getByText('Texto e storyboard')).toBeInTheDocument();
    expect(within(item(0)).getByText('R$ 100,00')).toBeInTheDocument();
    expect(within(item(0)).getByText('Liberado')).toBeInTheDocument();
    expect(item(1)).toHaveTextContent(/^2Gravação/);
    expect(within(item(1)).getByText('Entregue')).toBeInTheDocument();
    expect(item(2)).toHaveTextContent(/^3Edição/);
    expect(within(item(2)).getByText('Em escrow')).toBeInTheDocument();
    expect(within(item(3)).getByText('Cancelado')).toBeInTheDocument();
    expect(within(item(3)).getByText('R$ 50,00')).toBeInTheDocument();
    expect(within(item(4)).getByText('Aguardando aceite')).toBeInTheDocument();
    expect(within(item(4)).getByText('R$ 25,50')).toBeInTheDocument();
    // Marco sem prazo próprio, sem entrega e sem liberação: só número, título, valor e situação.
    expect(item(3)).toHaveTextContent(/^4LegendasR\$\s50,00Cancelado$/);
    expect(item(4)).toHaveTextContent(/^5TrilhaR\$\s25,50Aguardando aceite$/);
    // Cada situação tem a cor própria (a mesma escala das contratações).
    expect(within(item(0)).getByText('Liberado')).toHaveClass('pill', 'status-completed');
    expect(within(item(1)).getByText('Entregue')).toHaveClass('pill', 'status-delivered');
    expect(within(item(2)).getByText('Em escrow')).toHaveClass('pill', 'status-in_progress');
    expect(within(item(3)).getByText('Cancelado')).toHaveClass('pill', 'status-cancelled');
    expect(within(item(4)).getByText('Aguardando aceite')).toHaveClass('pill', 'status-pending');
  });

  it('situação que a tela não conhece aparece como veio da API, na cor neutra', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([milestone({ status: 'frozen' as Milestone['status'] })])}
          myId={FREELANCER}
        />,
      ),
    );
    expect(within(item(0)).getByText('frozen')).toHaveClass('pill', 'status-pending');
    // Sem situação conhecida, nenhuma ação é oferecida.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('nota de entrega sem a hora gravada: só a nota, sem data inventada', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({
              id: 2,
              title: 'Gravação',
              status: 'delivered',
              deliveredAt: null,
              deliveryNote: 'Vídeo bruto enviado',
            }),
          ])}
          myId={CLIENT}
        />,
      ),
    );
    expect(within(item(0)).getByText('Vídeo bruto enviado')).toBeInTheDocument();
    expect(item(0)).not.toHaveTextContent('·');
  });

  it('com tudo liberado, a barra chega a 100 e o cabeçalho soma o total', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract(
            [
              milestone({ id: 1, amount: 120, status: 'released', releasedAt: local(9, 23) }),
              milestone({ id: 2, amount: 180, status: 'released', releasedAt: local(9, 25) }),
            ],
            { status: 'completed' },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.getByText('2 de 2 liberados · R$ 300,00 de R$ 300,00')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progresso dos marcos' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });

  it('sem nenhum marco liberado, a barra fica em 0', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([milestone({ id: 1, amount: 300, status: 'delivered' })])}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.getByText('0 de 1 liberados · R$ 0,00 de R$ 300,00')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('"entregue com atraso" vale para o marco entregue ou liberado depois do prazo dele, nunca para o devolvido para revisão', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            // entregue (esperando o cliente) um dia depois do prazo
            milestone({
              id: 1,
              title: 'Gravação',
              status: 'delivered',
              dueAt: local(9, 28, 23, 59, 59),
              deliveredAt: local(9, 29, 10, 0),
              deliveryNote: 'Vídeo bruto',
            }),
            // liberado, entregue antes do prazo
            milestone({
              id: 2,
              title: 'Roteiro',
              status: 'released',
              dueAt: local(9, 20, 23, 59, 59),
              deliveredAt: local(9, 19, 10, 0),
              releasedAt: local(9, 21, 9, 0),
            }),
            // devolvido para revisão: a entrega antiga foi depois do prazo, mas não conta mais
            milestone({
              id: 3,
              title: 'Edição',
              status: 'funded',
              dueAt: local(9, 28, 23, 59, 59),
              deliveredAt: local(9, 29, 10, 0),
              revisionNote: 'Trocar a trilha',
            }),
          ])}
          myId={CLIENT}
        />,
      ),
    );
    expect(item(0)).toHaveTextContent('até 28/09/2026 · entregue com atraso');
    expect(item(1)).toHaveTextContent('até 20/09/2026');
    expect(item(1)).not.toHaveTextContent('entregue com atraso');
    expect(item(2)).toHaveTextContent('até 28/09/2026');
    expect(item(2)).not.toHaveTextContent('entregue com atraso');
    // Em revisão o prazo do marco também não volta a contar ("atrasada há…").
    expect(item(2)).not.toHaveTextContent('atrasada');
  });

  it('a aprovação automática só aparece no marco entregue que tem a hora gravada', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({
              id: 1,
              title: 'Roteiro',
              status: 'released',
              releasedAt: local(9, 23, 9, 15),
              approvalDueAt: '2026-10-03T12:00:00.000Z',
            }),
            milestone({ id: 2, title: 'Gravação', status: 'delivered', approvalDueAt: null }),
            milestone({
              id: 3,
              title: 'Edição',
              status: 'funded',
              approvalDueAt: '2026-10-03T12:00:00.000Z',
            }),
          ])}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.queryByText(/aprovação automática/)).toBeNull();
  });

  it('marco entregue de novo depois de uma revisão: mostra a entrega nova, sem o pedido de revisão antigo', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({
              id: 3,
              title: 'Edição',
              status: 'delivered',
              deliveredAt: local(9, 30, 18, 0),
              deliveryNote: 'Segundo corte',
              revisionNote: 'Trocar a trilha',
            }),
          ])}
          myId={CLIENT}
        />,
      ),
    );
    expect(item(0)).toHaveTextContent('Segundo corte · 30/09, 18:00');
    expect(item(0)).not.toHaveTextContent('Revisão pedida');
    expect(item(0)).not.toHaveTextContent('Trocar a trilha');
  });

  it('prazo do marco que vence hoje ou amanhã diz isso no lugar da contagem de dias', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({ id: 1, title: 'Roteiro', dueAt: local(10, 1, 23, 59, 59) }),
            milestone({ id: 2, title: 'Gravação', dueAt: local(10, 2, 23, 59, 59) }),
          ])}
          myId={FREELANCER}
        />,
      ),
    );
    expect(item(0)).toHaveTextContent('até 01/10/2026 · vence hoje');
    expect(item(1)).toHaveTextContent('até 02/10/2026 · vence amanhã');
  });

  it('marco liberado: a entrega (com atraso), a nota e quanto foi liberado, quando', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    const released = item(0);
    expect(released).toHaveTextContent('até 20/09/2026 · entregue com atraso');
    expect(released).toHaveTextContent('Roteiro no Drive · 22/09, 10:00');
    expect(released).toHaveTextContent('R$ 85,00 liberados em 23/09, 09:15');
  });

  it('marco entregue no prazo: sem "atraso", com a nota e a hora da aprovação automática no fuso de quem lê', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    const delivered = item(1);
    expect(delivered).toHaveTextContent('até 05/10/2026');
    expect(delivered).not.toHaveTextContent('entregue com atraso');
    expect(delivered).toHaveTextContent('Vídeo bruto enviado · 30/09, 18:00');
    expect(
      within(delivered).getByText('aprovação automática a partir de sáb, 03/10, às 09:00'),
    ).toBeInTheDocument();
    expect(delivered).not.toHaveTextContent('liberados em');
  });

  it('marco por entregar com a contratação aberta: quanto falta para o prazo dele', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={FREELANCER} />));
    expect(item(2)).toHaveTextContent('até 04/10/2026 · faltam 3 dias');
    // A até 3 dias, a contagem vem no tom de "perto".
    expect(within(item(2)).getByText('faltam 3 dias')).toHaveClass('deadline-text-soon');
    // Só o marco por entregar conta o prazo: o entregue e o liberado, não.
    expect(item(1)).not.toHaveTextContent('faltam');
    expect(item(0)).not.toHaveTextContent('atrasada');
  });

  it('marco por entregar com o prazo dele vencido: "atrasada há N dias"', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({ id: 3, title: 'Edição', dueAt: local(9, 29, 23, 59, 59) }),
          ])}
          myId={FREELANCER}
        />,
      ),
    );
    expect(item(0)).toHaveTextContent('até 29/09/2026 · atrasada há 2 dias');
    expect(within(item(0)).getByText('atrasada há 2 dias')).toHaveClass('deadline-text-late');
  });

  it('marco devolvido para revisão: mostra o pedido do cliente, sem a nota da entrega antiga nem contagem de prazo', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({
              id: 3,
              title: 'Edição',
              status: 'funded',
              dueAt: local(10, 4, 23, 59, 59),
              deliveredAt: local(9, 30, 18, 0),
              deliveryNote: 'Primeiro corte',
              revisionNote: 'Trocar a trilha',
            }),
          ])}
          myId={FREELANCER}
        />,
      ),
    );
    expect(item(0)).toHaveTextContent('Revisão pedida: Trocar a trilha');
    expect(item(0)).not.toHaveTextContent('Primeiro corte');
    expect(item(0)).toHaveTextContent('até 04/10/2026');
    expect(item(0)).not.toHaveTextContent('faltam');
  });

  it('contratação encerrada: o marco por entregar não conta prazo nem oferece ação', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract(three(), { status: 'cancelled' })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(item(2)).toHaveTextContent('até 04/10/2026');
    expect(item(2)).not.toHaveTextContent('faltam');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('em créditos: valores em "cr" arredondados e o liberado em créditos', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract(
            [
              milestone({
                id: 1,
                amount: 30,
                freelancerNet: 26.6,
                status: 'released',
                releasedAt: local(9, 23, 9, 15),
              }),
              milestone({ id: 2, title: 'Edição', amount: 30.4, freelancerNet: 27 }),
            ],
            { paymentMode: 'credits', price: 60 },
          )}
          myId={CLIENT}
        />,
      ),
    );
    expect(screen.getByText('1 de 2 liberados · 30 cr de 60 cr')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(item(0)).toHaveTextContent('27 créditos liberados em 23/09, 09:15');
    expect(within(item(1)).getByText('30 cr')).toBeInTheDocument();
  });
});

describe('MilestonesSection: as ações de cada lado', () => {
  it('o freelancer só vê "Entregar marco", e só no marco por entregar', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={FREELANCER} />));
    expect(within(item(0)).queryByRole('button')).toBeNull();
    expect(within(item(1)).queryByRole('button')).toBeNull();
    expect(
      within(item(2))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Entregar marco']);
  });

  it('o cliente só vê "Aprovar marco" e "Pedir revisão", e só no marco entregue', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    expect(within(item(0)).queryByRole('button')).toBeNull();
    expect(
      within(item(1))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Aprovar marco', 'Pedir revisão']);
    expect(within(item(2)).queryByRole('button')).toBeNull();
  });

  it('quem não é parte da contratação não vê ação nenhuma', () => {
    render(wrap(<MilestonesSection contract={contract(three())} myId={99} />));
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it.each(['delivered', 'completed', 'disputed', 'pending'] as const)(
    'contratação em "%s": os marcos ficam sem ação',
    (status) => {
      const { unmount } = render(
        wrap(<MilestonesSection contract={contract(three(), { status })} myId={CLIENT} />),
      );
      expect(screen.queryAllByRole('button')).toEqual([]);
      unmount();
      render(
        wrap(<MilestonesSection contract={contract(three(), { status })} myId={FREELANCER} />),
      );
      expect(screen.queryAllByRole('button')).toEqual([]);
    },
  );

  it('contratação aceita (ainda não iniciada) já aceita entrega de marco', () => {
    render(
      wrap(
        <MilestonesSection
          contract={contract(three(), { status: 'accepted' })}
          myId={FREELANCER}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: 'Entregar marco' })).toBeEnabled();
  });

  it('Entregar marco pergunta a mensagem daquele marco e manda o texto sem espaços nas pontas', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('  Corte final no Drive  ');
    render(wrap(<MilestonesSection contract={contract(three())} myId={FREELANCER} />));
    await user.click(screen.getByRole('button', { name: 'Entregar marco' }));
    expect(prompt).toHaveBeenCalledWith('Mensagem da entrega do marco «Edição»:');
    expect(milestoneAction).toHaveBeenCalledTimes(1);
    expect(milestoneAction).toHaveBeenCalledWith(9, 3, 'deliver', 'Corte final no Drive');
    expect(await screen.findByText('Marco entregue. O cliente foi avisado.')).toBeInTheDocument();
  });

  it.each<[string, string | null]>([
    ['cancelada', null],
    ['só com espaços', '   '],
  ])('entrega com a mensagem %s: nada vai para a API', async (_name, answer) => {
    const user = userEvent.setup();
    prompt.mockReturnValue(answer);
    render(wrap(<MilestonesSection contract={contract(three())} myId={FREELANCER} />));
    await user.click(screen.getByRole('button', { name: 'Entregar marco' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(milestoneAction).not.toHaveBeenCalled();
    expect(screen.queryByText('Marco entregue. O cliente foi avisado.')).toBeNull();
  });

  it('Aprovar marco não pergunta nada, aprova aquele marco e diz quanto foi liberado', async () => {
    const user = userEvent.setup();
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    await user.click(screen.getByRole('button', { name: 'Aprovar marco' }));
    expect(prompt).not.toHaveBeenCalled();
    expect(milestoneAction).toHaveBeenCalledTimes(1);
    expect(milestoneAction).toHaveBeenCalledWith(9, 2, 'approve', undefined);
    expect(
      await screen.findByText('Marco aprovado: R$ 85,00 liberados para o freelancer.'),
    ).toBeInTheDocument();
  });

  it('em créditos, a aprovação diz os créditos liberados', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <MilestonesSection
          contract={contract(
            [milestone({ id: 4, status: 'delivered', amount: 30, freelancerNet: 26.6 })],
            { paymentMode: 'credits', price: 30 },
          )}
          myId={CLIENT}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Aprovar marco' }));
    expect(milestoneAction).toHaveBeenCalledWith(9, 4, 'approve', undefined);
    expect(
      await screen.findByText('Marco aprovado: 27 créditos liberados para o freelancer.'),
    ).toBeInTheDocument();
  });

  it('Pedir revisão pergunta o que ajustar e manda o pedido, sem espaços nas pontas, para aquele marco', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('  Refazer a cena 2  ');
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    await user.click(screen.getByRole('button', { name: 'Pedir revisão' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith('O que precisa ser ajustado neste marco?');
    expect(milestoneAction).toHaveBeenCalledTimes(1);
    expect(milestoneAction).toHaveBeenCalledWith(9, 2, 'request-revision', 'Refazer a cena 2');
    expect(await screen.findByText('Revisão solicitada neste marco.')).toBeInTheDocument();
  });

  it.each<[string, string | null]>([
    ['cancelada', null],
    ['vazia', ''],
    ['só com espaços', '   '],
  ])('revisão com a pergunta %s (sem dizer o que ajustar) não é enviada', async (_name, answer) => {
    const user = userEvent.setup();
    prompt.mockReturnValue(answer);
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    await user.click(screen.getByRole('button', { name: 'Pedir revisão' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(milestoneAction).not.toHaveBeenCalled();
    expect(screen.queryByText('Revisão solicitada neste marco.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pedir revisão' })).toBeEnabled();
  });

  it('com dois marcos por entregar, cada botão entrega o marco da própria linha', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('Pronto');
    render(
      wrap(
        <MilestonesSection
          contract={contract([
            milestone({ id: 11, title: 'Roteiro' }),
            milestone({ id: 12, title: 'Gravação' }),
          ])}
          myId={FREELANCER}
        />,
      ),
    );
    await user.click(within(item(1)).getByRole('button', { name: 'Entregar marco' }));
    expect(prompt).toHaveBeenCalledWith('Mensagem da entrega do marco «Gravação»:');
    expect(milestoneAction).toHaveBeenCalledTimes(1);
    expect(milestoneAction).toHaveBeenCalledWith(9, 12, 'deliver', 'Pronto');
  });

  it('enquanto um marco é entregue, o "Entregar marco" dos outros também fica desabilitado', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('Pronto');
    let release!: (c: ContractWithHistory) => void;
    milestoneAction.mockReturnValue(new Promise<ContractWithHistory>((r) => (release = r)));
    const two = [milestone({ id: 11, title: 'Roteiro' }), milestone({ id: 12, title: 'Gravação' })];
    render(wrap(<MilestonesSection contract={contract(two)} myId={FREELANCER} />));
    const first = within(item(0)).getByRole('button', { name: 'Entregar marco' });
    const second = within(item(1)).getByRole('button', { name: 'Entregar marco' });
    await user.click(first);
    await waitFor(() => expect(first).toBeDisabled());
    expect(second).toBeDisabled();
    // O aviso de entrega só sai quando a API responde.
    expect(screen.queryByText('Marco entregue. O cliente foi avisado.')).toBeNull();
    release(contract(two));
    expect(await screen.findByText('Marco entregue. O cliente foi avisado.')).toBeInTheDocument();
    await waitFor(() => expect(first).toBeEnabled());
    expect(second).toBeEnabled();
    expect(milestoneAction).toHaveBeenCalledTimes(1);
    expect(milestoneAction).toHaveBeenCalledWith(9, 11, 'deliver', 'Pronto');
  });

  it('a API recusa a entrega do marco: o aviso é a mensagem dela e o botão volta a aceitar clique', async () => {
    const user = userEvent.setup();
    prompt.mockReturnValue('Pronto');
    milestoneAction.mockRejectedValue(new Error('A contratação foi cancelada'));
    render(wrap(<MilestonesSection contract={contract(three())} myId={FREELANCER} />));
    const deliver = screen.getByRole('button', { name: 'Entregar marco' });
    await user.click(deliver);
    expect(await screen.findByText('A contratação foi cancelada')).toBeInTheDocument();
    expect(screen.queryByText('Marco entregue. O cliente foi avisado.')).toBeNull();
    await waitFor(() => expect(deliver).toBeEnabled());
  });

  it('a API recusa: o aviso é a mensagem dela, sem o aviso de sucesso', async () => {
    const user = userEvent.setup();
    milestoneAction.mockRejectedValue(new Error('Este marco já foi aprovado'));
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    await user.click(screen.getByRole('button', { name: 'Aprovar marco' }));
    expect(await screen.findByText('Este marco já foi aprovado')).toBeInTheDocument();
    expect(screen.queryByText(/^Marco aprovado/)).toBeNull();
  });

  it('falha sem mensagem: o aviso é "Erro na ação"', async () => {
    const user = userEvent.setup();
    milestoneAction.mockRejectedValue('offline');
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    await user.click(screen.getByRole('button', { name: 'Aprovar marco' }));
    expect(await screen.findByText('Erro na ação')).toBeInTheDocument();
  });

  it('enquanto a ação está em curso, os botões dos marcos ficam desabilitados', async () => {
    const user = userEvent.setup();
    let release!: (c: ContractWithHistory) => void;
    milestoneAction.mockReturnValue(new Promise<ContractWithHistory>((r) => (release = r)));
    render(wrap(<MilestonesSection contract={contract(three())} myId={CLIENT} />));
    const approve = screen.getByRole('button', { name: 'Aprovar marco' });
    const revision = screen.getByRole('button', { name: 'Pedir revisão' });
    await user.click(approve);
    await waitFor(() => expect(approve).toBeDisabled());
    expect(revision).toBeDisabled();
    release(contract(three()));
    await waitFor(() => expect(approve).toBeEnabled());
    expect(revision).toBeEnabled();
    expect(milestoneAction).toHaveBeenCalledTimes(1);
  });
});
