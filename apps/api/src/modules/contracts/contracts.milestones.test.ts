import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: {
    feeRate: vi.fn().mockResolvedValue(0.15),
    number: vi.fn().mockResolvedValue(24),
  },
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn().mockResolvedValue(5) },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../auth/user-zone', () => ({
  userZone: vi.fn().mockResolvedValue('America/Sao_Paulo'),
}));

vi.mock('./contracts.repository', () => ({
  contractsRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    transition: vi.fn(),
    deliver: vi.fn(),
  },
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    listForContract: vi.fn().mockResolvedValue([]),
    escrowRemaining: vi.fn(),
    deliver: vi.fn(),
    approve: vi.fn(),
    requestRevision: vi.fn(),
    titlesByDelivery: vi.fn().mockResolvedValue({ delivered: [], missing: [] }),
  },
}));
vi.mock('../wallet/wallet.service', () => ({
  walletService: { ensure: vi.fn(), getBalance: vi.fn() },
}));
vi.mock('../gamification/gamification.service', () => ({
  gamificationService: { onContractCompleted: vi.fn(), onReviewReceived: vi.fn() },
}));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn().mockResolvedValue(undefined) },
}));

import { setClockForTests } from '../../utils/clock';
import { notificationsService } from '../notifications/notifications.service';
import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { milestonesRepository } from './milestones.repository';
import { gamificationService } from '../gamification/gamification.service';
import { settingsRepository } from '../settings/settings.repository';

const repo = vi.mocked(contractsRepository);
const ms = vi.mocked(milestonesRepository);

function row(
  o: Partial<{
    status: string;
    has_milestones: number;
    deadline_at: Date | null;
    payment_mode: string;
  }> = {},
): ContractRow {
  return {
    id: 1,
    ulid: '01CONTRACT',
    client_id: 1,
    freelancer_id: 2,
    service_id: null,
    title: 'Site em 3 etapas',
    description: 'Projeto longo dividido em marcos',
    price: '1000.00',
    platform_fee: '150.00',
    freelancer_net: '850.00',
    status: 'accepted',
    payment_mode: 'cash',
    has_milestones: 1,
    deadline_at: null,
    accepted_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  } as unknown as ContractRow;
}

beforeEach(() => vi.clearAllMocks());

describe('criação com marcos (RN-069)', () => {
  it('cada marco recebe o líquido com a taxa; o último absorve o arredondamento', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(row({ status: 'pending' }));
    await contractsService.create(1, {
      freelancerId: 2,
      title: 'Site em 3 etapas',
      description: 'Projeto longo dividido em marcos',
      price: 1000,
      paymentMode: 'cash',
      milestones: [
        {
          title: 'Layout',
          description: 'Telas no Figma',
          amount: 333.33,
          dueAt: '2026-12-01T02:59:59.000Z',
        },
        { title: 'Front', amount: 333.33 },
        { title: 'Deploy', amount: 333.34 },
      ],
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.milestones).toHaveLength(3);
    // Cada marco vai com o que o cliente escreveu, na ordem em que veio; sem descrição ou prazo, null.
    expect(arg.milestones).toEqual([
      {
        title: 'Layout',
        description: 'Telas no Figma',
        amount: 333.33,
        freelancerNet: 283.33,
        sortOrder: 0,
        dueAt: '2026-12-01T02:59:59.000Z',
      },
      {
        title: 'Front',
        description: null,
        amount: 333.33,
        freelancerNet: 283.33,
        sortOrder: 1,
        dueAt: null,
      },
      {
        title: 'Deploy',
        description: null,
        amount: 333.34,
        freelancerNet: 283.34,
        sortOrder: 2,
        dueAt: null,
      },
    ]);
    // O valor inteiro é reservado na proposta; os marcos só dividem a liberação.
    expect(arg.hold).toEqual({ userId: 1, amount: 1000 });
    expect(arg.freelancerNet).toBe(850);
    const nets = arg.milestones!.map((m) => m.freelancerNet);
    expect(nets[0]).toBe(283.33); // 333.33 × 0.85
    expect(nets[1]).toBe(283.33);
    expect(nets[2]).toBe(283.34); // 850 − 566.66
    expect(nets.reduce((a, b) => a + b, 0)).toBeCloseTo(850, 2);
    expect(arg.milestones!.map((m) => m.sortOrder)).toEqual([0, 1, 2]);
  });

  it('em créditos não há taxa: o líquido de cada marco é o próprio valor', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(row({ status: 'pending', payment_mode: 'credits' }));
    await contractsService.create(1, {
      freelancerId: 2,
      title: 'Manutenção em 2 visitas',
      description: 'Diagnóstico e depois as correções',
      price: 40,
      paymentMode: 'credits',
      milestones: [
        { title: 'Visita 1', amount: 20 },
        { title: 'Visita 2', amount: 20 },
      ],
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.paymentMode).toBe('credits');
    expect(arg.hold).toBeNull();
    expect(arg.milestones!.map((m) => [m.amount, m.freelancerNet])).toEqual([
      [20, 20],
      [20, 20],
    ]);
  });
});

describe('contrato por marcos não tem entrega/aprovação únicas', () => {
  it('deliver/approve/request-revision no contrato → 409 use_milestones', async () => {
    repo.findById.mockResolvedValue(row({ status: 'accepted' }));
    await expect(contractsService.deliver(1, 2, { message: 'x' })).rejects.toMatchObject({
      code: 'use_milestones',
    });
    repo.findById.mockResolvedValue(row({ status: 'delivered' }));
    await expect(contractsService.approve(1, 1)).rejects.toMatchObject({ code: 'use_milestones' });
    await expect(contractsService.requestRevision(1, 1, null)).rejects.toMatchObject({
      code: 'use_milestones',
    });
  });

  it('aceite financia os marcos na mesma transição', async () => {
    repo.findById
      .mockResolvedValueOnce(row({ status: 'pending' }))
      .mockResolvedValueOnce(row({ status: 'accepted' }));
    repo.transition.mockResolvedValue(true);
    await contractsService.accept(1, 2);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'accepted',
        milestonesTo: { from: ['pending'], to: 'funded' },
      }),
    );
  });
});

describe('entrega e aprovação por marco', () => {
  it('freelancer entrega; cliente aprova → libera só aquele líquido; último conclui e dá XP', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    ms.deliver.mockResolvedValue(true);
    // terça 18:20 em Brasília + 5 dias = domingo 18:20 (de dia): a aprovação tácita fica lá
    setClockForTests(new Date('2026-10-06T21:20:00Z'), { frozen: true });
    try {
      await contractsService.deliverMilestone(1, 7, 2, 'Layout no Figma');
    } finally {
      setClockForTests(null);
    }
    expect(ms.deliver).toHaveBeenCalledWith({
      contractId: 1,
      milestoneId: 7,
      changedBy: 2,
      message: 'Layout no Figma',
      now: new Date('2026-10-06T21:20:00Z'),
      approvalDueAt: new Date('2026-10-11T21:20:00Z'),
    });
    expect(vi.mocked(notificationsService.notify)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'milestone_delivered',
        body: 'Aprove ou peça revisão até dom, 11/10 às 18:20; depois disso, o marco é aprovado automaticamente. Mensagem: Layout no Figma',
      }),
      {},
    );

    ms.approve.mockResolvedValueOnce({ ok: true, completed: false, net: 283.33, title: 'Layout' });
    const first = await contractsService.approveMilestone(1, 7, 1);
    expect(first.completed).toBe(false);
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();

    ms.approve.mockResolvedValueOnce({ ok: true, completed: true, net: 283.34, title: 'Deploy' });
    const last = await contractsService.approveMilestone(1, 9, 1);
    expect(last.completed).toBe(true);
    expect(last.unit).toBe('BRL');
    expect(ms.approve).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'cash' }));
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(2, 1);
  });

  it('em créditos a aprovação libera créditos (modo passado ao repositório)', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress', payment_mode: 'credits' }));
    ms.approve.mockResolvedValueOnce({ ok: true, completed: false, net: 20, title: 'Visita 1' });
    const r = await contractsService.approveMilestone(1, 7, 1);
    expect(ms.approve).toHaveBeenCalledWith(expect.objectContaining({ mode: 'credits' }));
    expect(r).toMatchObject({ net: 20, unit: 'credits', completed: false });
  });

  it('só o freelancer entrega e só o cliente aprova; marco fora de estado → 409', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    await expect(contractsService.deliverMilestone(1, 7, 1, 'x')).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Ação exclusiva do freelancer',
    });
    await expect(contractsService.approveMilestone(1, 7, 2)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Ação exclusiva do cliente',
    });
    expect(ms.deliver).not.toHaveBeenCalled();
    expect(ms.approve).not.toHaveBeenCalled();
    ms.approve.mockResolvedValue({ ok: false, completed: false, net: 0, title: '' });
    await expect(contractsService.approveMilestone(1, 7, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
  });

  it('aprovação tácita de marco só em contrato aberto', async () => {
    repo.findById.mockResolvedValue(row({ status: 'completed' }));
    expect(
      await contractsService.approveMilestoneTacitly({
        id: 7,
        contract_id: 1,
        client_id: 1,
        freelancer_id: 2,
        approval_due_at: new Date(),
      } as never),
    ).toBe(false);
    expect(ms.approve).not.toHaveBeenCalled();
  });

  it('aprovação tácita de marco: em nome do cliente, só se a hora gravada já passou, e o último dá o XP', async () => {
    const due = {
      id: 7,
      contract_id: 1,
      client_id: 1,
      freelancer_id: 2,
      approval_due_at: new Date('2026-10-11T21:20:00Z'), // dom, 18:20 em Brasília
    } as never;
    const now = new Date('2026-10-11T21:25:00Z');
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));

    ms.approve.mockResolvedValueOnce({ ok: true, completed: true, net: 283.34, title: 'Deploy' });
    expect(await contractsService.approveMilestoneTacitly(due, now)).toBe(true);
    expect(ms.approve).toHaveBeenCalledWith({
      contractId: 1,
      milestoneId: 7,
      changedBy: 1,
      freelancerId: 2,
      mode: 'cash',
      note: 'Aprovação tácita: sem resposta do cliente até 11/10/2026 às 18:20 (horário de Brasília)',
      now,
      // A gravação repete a hora: uma revisão seguida de nova entrega no meio grava outra.
      dueBy: now,
    });
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(2, 1);

    // Não era o último marco: aprova, mas a contratação segue (sem XP).
    vi.mocked(gamificationService.onContractCompleted).mockClear();
    ms.approve.mockResolvedValueOnce({ ok: true, completed: false, net: 283.33, title: 'Layout' });
    expect(await contractsService.approveMilestoneTacitly(due, now)).toBe(true);
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();

    // O cliente respondeu no meio (o marco saiu de entregue): nada acontece.
    ms.approve.mockResolvedValueOnce({ ok: false, completed: false, net: 0, title: '' });
    expect(await contractsService.approveMilestoneTacitly(due, now)).toBe(false);
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();
  });

  it('aprovação tácita de marco em créditos libera créditos', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress', payment_mode: 'credits' }));
    ms.approve.mockResolvedValueOnce({ ok: true, completed: false, net: 20, title: 'Visita 1' });
    await contractsService.approveMilestoneTacitly(
      {
        id: 7,
        contract_id: 1,
        client_id: 1,
        freelancer_id: 2,
        approval_due_at: new Date('2026-10-11T21:20:00Z'),
      } as never,
      new Date('2026-10-11T21:25:00Z'),
    );
    expect(ms.approve).toHaveBeenCalledWith(expect.objectContaining({ mode: 'credits' }));
  });

  it('marco que não está financiado (ou contrato fora de aceito/em andamento): 409 e o cliente não é avisado', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    ms.deliver.mockResolvedValue(false);
    await expect(contractsService.deliverMilestone(1, 7, 2, 'Layout')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'Este marco não está aguardando entrega',
    });

    ms.deliver.mockClear();
    repo.findById.mockResolvedValue(row({ status: 'completed' }));
    await expect(contractsService.deliverMilestone(1, 7, 2, 'Layout')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(ms.deliver).not.toHaveBeenCalled();
    expect(vi.mocked(notificationsService.notify)).not.toHaveBeenCalled();
  });
});

describe('revisão por marco', () => {
  it('só o cliente pede, e só com a contratação aceita ou em andamento', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    await expect(contractsService.requestMilestoneRevision(1, 7, 2, 'x')).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    repo.findById.mockResolvedValue(row({ status: 'completed' }));
    await expect(contractsService.requestMilestoneRevision(1, 7, 1, 'x')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(ms.requestRevision).not.toHaveBeenCalled();
  });

  it('pede a revisão em nome do cliente e devolve a contratação com os marcos', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    ms.requestRevision.mockResolvedValue(true);
    ms.listForContract.mockResolvedValueOnce([
      {
        id: 7,
        contract_id: 1,
        title: 'Layout',
        description: null,
        amount: '333.33',
        freelancer_net: '283.33',
        sort_order: 0,
        status: 'funded',
        due_at: new Date('2026-10-12T02:59:59Z'),
        delivered_at: new Date('2026-10-06T21:20:00Z'),
        // Sobra da entrega anterior: fora de "entregue", a API não mostra hora de aprovação.
        approval_due_at: new Date('2026-10-11T21:20:00Z'),
        delivery_note: 'Layout no Figma',
        revision_note: 'Ajustar o topo',
        released_at: null,
      },
      {
        id: 8,
        contract_id: 1,
        title: 'Front',
        description: 'Páginas internas',
        amount: '666.67',
        freelancer_net: '566.67',
        sort_order: 1,
        status: 'delivered',
        due_at: null,
        delivered_at: new Date('2026-10-06T21:20:00Z'),
        approval_due_at: new Date('2026-10-11T21:20:00Z'),
        delivery_note: 'No ar',
        revision_note: null,
        released_at: null,
      },
      {
        id: 9,
        contract_id: 1,
        title: 'Briefing',
        description: null,
        amount: '100.00',
        freelancer_net: '85.00',
        sort_order: 2,
        status: 'released',
        due_at: null,
        delivered_at: null,
        approval_due_at: null,
        delivery_note: null,
        revision_note: null,
        released_at: new Date('2026-10-05T15:00:00Z'),
      },
    ] as never);

    const c = await contractsService.requestMilestoneRevision(1, 7, 1, 'Ajustar o topo');

    expect(ms.requestRevision).toHaveBeenCalledWith({
      contractId: 1,
      milestoneId: 7,
      changedBy: 1,
      note: 'Ajustar o topo',
    });
    expect(c.id).toBe(1);
    // Os marcos saem no formato da API: valores em número e datas em ISO.
    expect(c.milestones).toEqual([
      {
        id: 7,
        title: 'Layout',
        description: null,
        amount: 333.33,
        freelancerNet: 283.33,
        sortOrder: 0,
        status: 'funded',
        dueAt: '2026-10-12T02:59:59.000Z',
        deliveredAt: '2026-10-06T21:20:00.000Z',
        deliveryNote: 'Layout no Figma',
        revisionNote: 'Ajustar o topo',
        releasedAt: null,
        approvalDueAt: null,
      },
      {
        id: 8,
        title: 'Front',
        description: 'Páginas internas',
        amount: 666.67,
        freelancerNet: 566.67,
        sortOrder: 1,
        status: 'delivered',
        dueAt: null,
        deliveredAt: '2026-10-06T21:20:00.000Z',
        deliveryNote: 'No ar',
        revisionNote: null,
        releasedAt: null,
        approvalDueAt: '2026-10-11T21:20:00.000Z',
      },
      {
        id: 9,
        title: 'Briefing',
        description: null,
        amount: 100,
        freelancerNet: 85,
        sortOrder: 2,
        status: 'released',
        dueAt: null,
        deliveredAt: null,
        deliveryNote: null,
        revisionNote: null,
        releasedAt: '2026-10-05T15:00:00.000Z',
        approvalDueAt: null,
      },
    ]);
  });

  it('marco que não está entregue: 409 invalid_transition', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    ms.requestRevision.mockResolvedValue(false);
    await expect(contractsService.requestMilestoneRevision(1, 7, 1, null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'Este marco não está aguardando aprovação',
    });
  });
});

describe('cancelamento por marcos liquida só o que ainda não foi liberado', () => {
  it('com marco entregue esperando o cliente, não cancela (ADR 57)', async () => {
    repo.findById.mockResolvedValue({
      ...row({ status: 'in_progress' }),
      delivered_awaiting: 1,
    } as never);
    ms.escrowRemaining.mockResolvedValue({ price: 400, net: 340 });
    await expect(contractsService.cancel(1, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'milestone_open',
      message:
        'Há marco entregue esperando a sua resposta: aprove, peça revisão ou abra uma disputa antes de cancelar.',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('50% do restante volta ao cliente; marcos abertos ficam cancelados', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    ms.escrowRemaining.mockResolvedValue({ price: 400, net: 340 }); // 600 já liberados
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r.refundPercentage).toBe(50);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        milestonesTo: { from: ['pending', 'funded', 'delivered'], to: 'cancelled' },
        guard: expect.objectContaining({
          sql: expect.stringContaining('= :gEscrowCents'),
          params: expect.objectContaining({ gEscrowCents: 40000 }),
        }),
        walletEffects: [
          { userId: 2, pendingDelta: -340, balanceDelta: 170, reason: 'escrow_release' },
          { userId: 1, pendingDelta: 0, balanceDelta: 200, reason: 'refund' },
        ],
      }),
    );
  });
});

/**
 * Ids que não se repetem (contratação 31, marcos 5 e 6, cliente 7, freelancer 44): nos exemplos
 * acima a contratação e o cliente têm o mesmo número, e uma troca entre os dois passaria
 * despercebida.
 */
const other = (o: Parameters<typeof row>[0] = {}): ContractRow =>
  ({ ...row(o), id: 31, client_id: 7, freelancer_id: 44 }) as ContractRow;

const notify = vi.mocked(notificationsService.notify);

describe('marcos: quem age, quem recebe e quem é avisado (RN-069)', () => {
  // Terça, 20:45 em Brasília (já noite) e 19:45 em Manaus (ainda dia).
  const AT = new Date('2026-10-06T23:45:00Z');
  beforeEach(() => setClockForTests(AT, { frozen: true }));
  afterEach(() => setClockForTests(null));

  it('a entrega do marco grava a aprovação tácita no fuso do cliente, avisa o cliente com o título do marco e devolve a contratação relida', async () => {
    repo.findById.mockResolvedValue({
      ...other({ status: 'in_progress' }),
      client_timezone: 'America/Manaus',
    } as ContractRow);
    ms.deliver.mockResolvedValue(true);
    const delivered = {
      id: 5,
      contract_id: 31,
      title: 'Layout',
      description: null,
      amount: '333.33',
      freelancer_net: '283.33',
      sort_order: 0,
      status: 'delivered',
      due_at: null,
      delivered_at: AT,
      approval_due_at: new Date('2026-10-11T23:45:00Z'),
      delivery_note: 'Layout no Figma',
      revision_note: null,
      released_at: null,
    };
    ms.listForContract.mockResolvedValueOnce([
      delivered,
      {
        ...delivered,
        id: 6,
        title: 'Publicação',
        status: 'funded',
        delivered_at: null,
        approval_due_at: null,
        delivery_note: null,
      },
    ] as never);

    const c = await contractsService.deliverMilestone(31, 5, 44, 'Layout no Figma');

    // Os dias da aprovação tácita vêm do painel, com 5 de padrão.
    expect(settingsRepository.getNumber).toHaveBeenCalledWith('tacit_approval_days', 5);
    expect(ms.deliver).toHaveBeenCalledWith({
      contractId: 31,
      milestoneId: 5,
      changedBy: 44,
      message: 'Layout no Figma',
      now: AT,
      // 5 dias depois, 19:45 em Manaus: de dia, fica onde caiu (em Brasília iria para as 9h).
      approvalDueAt: new Date('2026-10-11T23:45:00Z'),
    });
    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(ms.listForContract).toHaveBeenCalledWith(31);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      7,
      {
        type: 'milestone_delivered',
        title: 'Marco entregue: Layout',
        body: 'Aprove ou peça revisão até dom, 11/10 às 19:45; depois disso, o marco é aprovado automaticamente. Mensagem: Layout no Figma',
        data: { contractId: 31, milestoneId: 5 },
      },
      {},
    );
    expect(c.id).toBe(31);
    expect(c.milestones.map((m) => [m.id, m.status, m.approvalDueAt])).toEqual([
      [5, 'delivered', '2026-10-11T23:45:00.000Z'],
      [6, 'funded', null],
    ]);
  });

  it('o primeiro marco pode ser entregue com a contratação ainda só aceita; antes do aceite ou depois de encerrada, não', async () => {
    ms.deliver.mockResolvedValue(true);
    for (const status of ['accepted', 'in_progress']) {
      repo.findById.mockResolvedValue(other({ status }));
      await contractsService.deliverMilestone(31, 5, 44, 'Layout');
    }
    expect(ms.deliver).toHaveBeenCalledTimes(2);

    ms.deliver.mockClear();
    for (const status of ['pending', 'completed', 'cancelled', 'disputed']) {
      repo.findById.mockResolvedValue(other({ status }));
      await expect(
        contractsService.deliverMilestone(31, 5, 44, 'Layout'),
        status,
      ).rejects.toMatchObject({ statusCode: 409, code: 'invalid_transition' });
    }
    expect(ms.deliver).not.toHaveBeenCalled();
  });

  it('a aprovação do marco fica em nome do cliente, libera ao freelancer da contratação e devolve o que foi liberado', async () => {
    repo.findById.mockResolvedValue(other({ status: 'accepted' }));
    ms.approve.mockResolvedValueOnce({ ok: true, completed: false, net: 283.33, title: 'Layout' });

    const r = await contractsService.approveMilestone(31, 5, 7);

    expect(ms.approve).toHaveBeenCalledTimes(1);
    // Sem hora-limite (dueBy): a aprovação manual vale a qualquer momento; só a tácita repete a hora.
    expect(ms.approve.mock.calls[0]![0]).toStrictEqual({
      contractId: 31,
      milestoneId: 5,
      changedBy: 7,
      freelancerId: 44,
      mode: 'cash',
      note: null,
      now: AT,
    });
    expect(r).toMatchObject({ completed: false, net: 283.33, title: 'Layout', unit: 'BRL' });
    expect(r.contract).toMatchObject({ id: 31, clientId: 7, freelancerId: 44 });
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();
  });

  it('o último marco aprovado dá o XP ao freelancer da contratação', async () => {
    repo.findById.mockResolvedValue(other({ status: 'in_progress' }));
    ms.approve.mockResolvedValueOnce({
      ok: true,
      completed: true,
      net: 283.34,
      title: 'Publicação',
    });

    const r = await contractsService.approveMilestone(31, 6, 7);

    expect(r).toMatchObject({ completed: true, net: 283.34, title: 'Publicação' });
    expect(gamificationService.onContractCompleted).toHaveBeenCalledTimes(1);
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(44, 31);
  });

  it('contratação que não está aceita nem em andamento não tem marco a aprovar: 409, e o escrow não é tocado', async () => {
    for (const status of ['pending', 'completed', 'cancelled', 'disputed']) {
      repo.findById.mockResolvedValue(other({ status }));
      await expect(contractsService.approveMilestone(31, 5, 7), status).rejects.toMatchObject({
        statusCode: 409,
        code: 'invalid_transition',
      });
    }
    expect(ms.approve).not.toHaveBeenCalled();
  });

  it('marco que não está esperando aprovação: 409 com a mensagem do marco, sem XP', async () => {
    repo.findById.mockResolvedValue(other({ status: 'in_progress' }));
    ms.approve.mockResolvedValueOnce({ ok: false, completed: false, net: 0, title: '' });
    await expect(contractsService.approveMilestone(31, 5, 7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'Este marco não está aguardando aprovação',
    });
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();
  });

  it('a aprovação tácita do marco busca a contratação do marco, age em nome do cliente dela e vale também para a contratação só aceita', async () => {
    const due = {
      id: 5,
      contract_id: 31,
      client_id: 7,
      freelancer_id: 44,
      approval_due_at: new Date('2026-10-06T21:20:00Z'), // 18:20 em Brasília
    } as never;
    repo.findById.mockResolvedValue(other({ status: 'accepted' }));
    ms.approve.mockResolvedValueOnce({
      ok: true,
      completed: true,
      net: 283.34,
      title: 'Publicação',
    });

    // Sem instante informado, vale o relógio do fluxo.
    expect(await contractsService.approveMilestoneTacitly(due)).toBe(true);

    expect(repo.findById.mock.calls).toEqual([[31]]);
    expect(ms.approve).toHaveBeenCalledWith({
      contractId: 31,
      milestoneId: 5,
      changedBy: 7,
      freelancerId: 44,
      mode: 'cash',
      note: 'Aprovação tácita: sem resposta do cliente até 06/10/2026 às 18:20 (horário de Brasília)',
      now: AT,
      dueBy: AT,
    });
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(44, 31);
  });

  it('a revisão do marco fica em nome do cliente; sem nota, vai null', async () => {
    repo.findById.mockResolvedValue(other({ status: 'accepted' }));
    ms.requestRevision.mockResolvedValue(true);

    const c = await contractsService.requestMilestoneRevision(31, 5, 7, null);

    expect(ms.requestRevision).toHaveBeenCalledWith({
      contractId: 31,
      milestoneId: 5,
      changedBy: 7,
      note: null,
    });
    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(c).toMatchObject({ id: 31, clientId: 7, freelancerId: 44 });
  });

  it('cancelamento em créditos por marcos: só os créditos ainda retidos voltam ao cliente, e os marcos abertos são cancelados', async () => {
    repo.findById.mockResolvedValue(other({ status: 'in_progress', payment_mode: 'credits' }));
    // Dos 850 créditos da contratação, 830 já foram liberados em marcos aprovados.
    ms.escrowRemaining.mockResolvedValueOnce({ price: 20, net: 20 });
    repo.transition.mockResolvedValue(true);

    const r = await contractsService.cancel(31, 7);

    expect(ms.escrowRemaining).toHaveBeenCalledWith(31);
    expect(r).toEqual({
      status: 'cancelled',
      refundPercentage: 100,
      stage: 'credits',
      by: 'client',
      refundClient: 20,
      releaseFreelancer: 0,
      unit: 'credits',
    });
    const call = repo.transition.mock.calls[0]![0];
    expect(call).toMatchObject({ id: 31, changedBy: 7, from: 'in_progress', to: 'cancelled' });
    expect(call.creditsEffects).toEqual([
      { userId: 44, pendingDelta: -20, balanceDelta: 0, reason: 'escrow_refund' },
      { userId: 7, pendingDelta: 0, balanceDelta: 20, reason: 'refund' },
    ]);
    expect(call.walletEffects).toBeUndefined();
    expect(call.milestonesTo).toEqual({
      from: ['pending', 'funded', 'delivered'],
      to: 'cancelled',
    });
    expect(call.guard!.params).toMatchObject({ gEscrowCents: 2000 });
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({ body: 'Os 20 créditos em garantia voltaram ao cliente.' }),
      {},
    );
  });
});
