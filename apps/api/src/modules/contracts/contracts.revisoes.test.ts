import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClockForTests } from '../../utils/clock';
import type { ContractRow } from './contracts.repository';
import type { MilestoneRow } from './milestones.repository';

vi.mock('../dropouts/dropouts.repository', () => ({
  dropoutsRepository: {
    listCounting: vi.fn().mockResolvedValue([]),
    findByContractId: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./contracts.repository', () => ({
  contractsRepository: {
    findById: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    transition: vi.fn().mockResolvedValue(true),
    grantRevision: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    findById: vi.fn(),
    listForContract: vi.fn().mockResolvedValue([]),
    escrowRemaining: vi.fn().mockResolvedValue(null),
    requestRevision: vi.fn().mockResolvedValue(true),
    grantRevision: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('./offers.repository', () => ({
  offersRepository: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../settings/settings.service', () => ({
  settingsService: {
    number: vi.fn().mockResolvedValue(3),
    feeRate: vi.fn().mockResolvedValue(0.15),
  },
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn().mockResolvedValue(3) },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { notificationsService } from '../notifications/notifications.service';
import { contractsRepository } from './contracts.repository';
import { contractsService } from './contracts.service';
import { milestonesRepository } from './milestones.repository';

const NOW = new Date('2026-10-08T15:00:00Z');
const DUE = new Date('2026-10-11T15:00:00Z');
const repo = vi.mocked(contractsRepository);
const ms = vi.mocked(milestonesRepository);
const notices = vi.mocked(notificationsService.notify);
const row = (extra: Partial<Omit<ContractRow, 'constructor'>> = {}) =>
  ({
    id: 31,
    client_id: 7,
    freelancer_id: 44,
    title: 'Entrega',
    status: 'delivered',
    payment_mode: 'cash',
    price: '100.00',
    platform_fee: '15.00',
    freelancer_net: '85.00',
    has_milestones: 0,
    revisions_used: 2,
    revision_limit: 2,
    first_delivery_at: NOW,
    delivery_dispute_opens_at: new Date('2026-10-10T15:00:00Z'),
    approval_due_at: DUE,
    created_at: NOW,
    accepted_at: NOW,
    deadline_at: null,
    barter_agreement_id: null,
    client_timezone: 'America/Sao_Paulo',
    freelancer_timezone: 'America/Sao_Paulo',
    ...extra,
  }) as ContractRow;
const milestone = (extra: Partial<Omit<MilestoneRow, 'constructor'>> = {}) =>
  ({
    id: 81,
    contract_id: 31,
    title: 'Layout',
    status: 'delivered',
    revisions_used: 2,
    revision_limit: 2,
    amount: '40.00',
    freelancer_net: '34.00',
    delivered_at: NOW,
    approval_due_at: DUE,
    dispute_opens_at: new Date('2026-10-10T15:00:00Z'),
    created_at: NOW,
    ...extra,
  }) as MilestoneRow;

beforeEach(() => {
  vi.clearAllMocks();
  setClockForTests(NOW, { frozen: true });
  repo.findById.mockReset().mockResolvedValue(row());
  repo.transition.mockReset().mockResolvedValue(true);
  repo.grantRevision.mockReset().mockResolvedValue(true);
  ms.findById.mockReset().mockResolvedValue(milestone());
  ms.listForContract.mockReset().mockResolvedValue([]);
  ms.requestRevision.mockReset().mockResolvedValue(true);
  ms.grantRevision.mockReset().mockResolvedValue(true);
});
afterEach(() => setClockForTests(null));

describe('liberar mais uma revisão', () => {
  it.each([7, 999])('usuário %s não pode liberar revisão em nome do freelancer', async (uid) => {
    await expect(contractsService.grantRevision(31, uid)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    expect(repo.grantRevision).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it.each(['pending', 'accepted', 'in_progress', 'revision_requested', 'completed', 'disputed'])(
    'não libera fora de entregue: %s',
    async (status) => {
      repo.findById.mockResolvedValue(row({ status }));
      await expect(contractsService.grantRevision(31, 44)).rejects.toMatchObject({
        statusCode: 409,
        code: 'invalid_transition',
      });
      expect(repo.grantRevision).not.toHaveBeenCalled();
      expect(notices).not.toHaveBeenCalled();
    },
  );

  it.each([
    { revision_limit: null, revisions_used: 5, code: 'revision_unlimited' },
    { revision_limit: 2, revisions_used: 1, code: 'revision_grant_not_needed' },
    { revision_limit: 4294967295, revisions_used: 4294967295, code: 'revision_grant_limit' },
  ])('bloqueia liberação incompatível com o saldo: $code', async ({ code, ...state }) => {
    repo.findById.mockResolvedValue(row(state));
    await expect(contractsService.grantRevision(31, 44)).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(repo.grantRevision).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it.each([2, 255])(
    'liberação após %s revisões avisa o cliente e conserva a tácita',
    async (limit) => {
      repo.findById
        .mockResolvedValueOnce(row({ revision_limit: limit, revisions_used: limit }))
        .mockResolvedValue(row({ revision_limit: limit + 1, revisions_used: limit }));
      const result = await contractsService.grantRevision(31, 44);
      expect(result.revisions).toEqual({ used: limit, limit: limit + 1 });
      expect(result.approvalDueAt).toBe(DUE.toISOString());
      expect(repo.grantRevision).toHaveBeenCalledExactlyOnceWith({
        id: 31,
        changedBy: 44,
        now: NOW,
        expectedRevisionsUsed: limit,
        expectedRevisionLimit: limit,
      });
      expect(repo.transition).not.toHaveBeenCalled();
      expect(notices).toHaveBeenCalledOnce();
      expect(notices).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: 'contract_revision_granted', data: { contractId: 31 } }),
        {},
      );
    },
  );

  it('relê o limite depois de uma liberação concorrente e não emite aviso duplicado', async () => {
    repo.grantRevision.mockResolvedValue(false);
    repo.findById.mockResolvedValueOnce(row()).mockResolvedValue(row({ revision_limit: 3 }));
    await expect(contractsService.grantRevision(31, 44)).rejects.toMatchObject({
      statusCode: 409,
      code: 'revision_grant_not_needed',
    });
    expect(notices).not.toHaveBeenCalled();
  });
});

describe('pedido de revisão', () => {
  it.each([
    ['America/Sao_Paulo', '12:00'],
    ['America/Manaus', '11:00'],
    ['America/Rio_Branco', '10:00'],
    ['America/Noronha', '13:00'],
  ] as const)('limite esgotado informa a hora da disputa no fuso %s', async (zone, hour) => {
    repo.findById.mockResolvedValue(row({ client_timezone: zone }));
    await expect(contractsService.requestRevision(31, 7, 'Ajustar')).rejects.toMatchObject({
      statusCode: 409,
      code: 'revision_limit',
      message: expect.stringContaining('a partir de sáb, 10/10 às ' + hour),
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'no instante da abertura + %s ms indica disputa disponível sem espera',
    async (offset) => {
      setClockForTests(new Date(Date.parse('2026-10-10T15:00:00Z') + offset), { frozen: true });
      await expect(contractsService.requestRevision(31, 7, 'Ajustar')).rejects.toMatchObject({
        code: 'revision_limit',
        message: expect.stringContaining('ou abra uma disputa.'),
      });
      await expect(contractsService.requestRevision(31, 7, 'Ajustar')).rejects.not.toMatchObject({
        message: expect.stringContaining('a partir de'),
      });
      expect(repo.transition).not.toHaveBeenCalled();
      expect(notices).not.toHaveBeenCalled();
    },
  );

  it('relê a abertura e informa a hora quando uma corrida esgota as revisões', async () => {
    repo.transition.mockResolvedValue(false);
    repo.findById
      .mockResolvedValueOnce(
        row({ revisions_used: 1, delivery_dispute_opens_at: new Date('2026-10-09T15:00:00Z') }),
      )
      .mockResolvedValue(row());
    await expect(contractsService.requestRevision(31, 7, 'Ajustar')).rejects.toMatchObject({
      code: 'revision_limit',
      message: expect.stringContaining('a partir de sáb, 10/10 às 12:00'),
    });
    expect(notices).not.toHaveBeenCalled();
  });

  it('não consome revisão quando o limite já se esgotou', async () => {
    await expect(contractsService.requestRevision(31, 7, 'Ajustar')).rejects.toMatchObject({
      statusCode: 409,
      code: 'revision_limit',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it.each([null, 2])(
    'incremento e guarda do contador acompanham o pedido (limite=%s)',
    async (limit) => {
      repo.findById
        .mockResolvedValueOnce(row({ revision_limit: limit, revisions_used: 1 }))
        .mockResolvedValue(
          row({ status: 'revision_requested', revision_limit: limit, revisions_used: 2 }),
        );
      const result = await contractsService.requestRevision(31, 7, 'Ajustar');
      expect(result.revisions).toEqual({ used: 2, limit });
      expect(repo.transition).toHaveBeenCalledExactlyOnceWith({
        id: 31,
        changedBy: 7,
        from: 'delivered',
        to: 'revision_requested',
        note: 'Ajustar',
        timestampColumn: 'revision_requested_at',
        now: NOW,
        countRevision: true,
        guard: { sql: 'AND c.revisions_used = :revisionUsed', params: { revisionUsed: 1 } },
      });
      expect(notices).toHaveBeenCalledWith(
        44,
        expect.objectContaining({ type: 'contract_revision' }),
        {},
      );
    },
  );

  it('corrida que esgota o limite retorna revision_limit e não avisa novamente', async () => {
    repo.transition.mockResolvedValue(false);
    repo.findById.mockResolvedValueOnce(row({ revisions_used: 1 })).mockResolvedValue(row());
    await expect(contractsService.requestRevision(31, 7, 'Ajustar')).rejects.toMatchObject({
      statusCode: 409,
      code: 'revision_limit',
    });
    expect(notices).not.toHaveBeenCalled();
  });
});

describe('revisões por marco', () => {
  beforeEach(() =>
    repo.findById.mockResolvedValue(row({ status: 'in_progress', has_milestones: 1 })),
  );

  it.each([7, 999])('usuário %s não libera revisão do marco', async (uid) => {
    await expect(contractsService.grantMilestoneRevision(31, 81, uid)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    expect(ms.grantRevision).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'funded', revision_limit: 2, revisions_used: 2, code: 'invalid_transition' },
    { status: 'delivered', revision_limit: null, revisions_used: 256, code: 'revision_unlimited' },
    {
      status: 'delivered',
      revision_limit: 2,
      revisions_used: 1,
      code: 'revision_grant_not_needed',
    },
  ])('não libera marco com estado incompatível: $code', async ({ code, ...state }) => {
    ms.findById.mockResolvedValue(milestone(state));
    await expect(contractsService.grantMilestoneRevision(31, 81, 44)).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(ms.grantRevision).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
  });

  it('libera somente o marco pedido e avisa o cliente com id e título do marco', async () => {
    ms.listForContract.mockResolvedValue([milestone({ revision_limit: 3 })]);
    const result = await contractsService.grantMilestoneRevision(31, 81, 44);
    expect(ms.grantRevision).toHaveBeenCalledExactlyOnceWith({
      contractId: 31,
      milestoneId: 81,
      changedBy: 44,
      now: NOW,
      expectedRevisionsUsed: 2,
      expectedRevisionLimit: 2,
    });
    expect(repo.grantRevision).not.toHaveBeenCalled();
    expect(result.milestones[0]!.revisions).toEqual({ used: 2, limit: 3 });
    expect(result.milestones[0]!.approvalDueAt).toBe(DUE.toISOString());
    expect(notices).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'contract_revision_granted',
        data: { contractId: 31, milestoneId: 81 },
      }),
      {},
    );
  });

  it('pedido do marco inclui o contador lido para bloquear ABA depois de outra reentrega', async () => {
    ms.findById.mockResolvedValue(milestone({ revisions_used: 1 }));
    ms.listForContract.mockResolvedValue([milestone({ status: 'funded', revisions_used: 2 })]);
    const result = await contractsService.requestMilestoneRevision(31, 81, 7, 'Ajustar');
    expect(ms.requestRevision).toHaveBeenCalledExactlyOnceWith({
      contractId: 31,
      milestoneId: 81,
      changedBy: 7,
      note: 'Ajustar',
      now: NOW,
      expectedRevisionsUsed: 1,
    });
    expect(result.milestones[0]!.revisions).toEqual({ used: 2, limit: 2 });
    expect(notices).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        type: 'milestone_revision',
        data: { contractId: 31, milestoneId: 81 },
      }),
      {},
    );
  });
});
