import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { milestonesRepository } from './milestones.repository';
import { gamificationService } from '../gamification/gamification.service';

const repo = vi.mocked(contractsRepository);
const ms = vi.mocked(milestonesRepository);

function row(
  o: Partial<{ status: string; has_milestones: number; deadline_at: Date | null }> = {},
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
        { title: 'Layout', amount: 333.33 },
        { title: 'Front', amount: 333.33 },
        { title: 'Deploy', amount: 333.34 },
      ],
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.milestones).toHaveLength(3);
    const nets = arg.milestones!.map((m) => m.freelancerNet);
    expect(nets[0]).toBe(283.33); // 333.33 × 0.85
    expect(nets[1]).toBe(283.33);
    expect(nets[2]).toBe(283.34); // 850 − 566.66
    expect(nets.reduce((a, b) => a + b, 0)).toBeCloseTo(850, 2);
    expect(arg.milestones!.map((m) => m.sortOrder)).toEqual([0, 1, 2]);
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
    await contractsService.deliverMilestone(1, 7, 2, 'Layout no Figma');
    expect(ms.deliver).toHaveBeenCalledWith({
      contractId: 1,
      milestoneId: 7,
      changedBy: 2,
      message: 'Layout no Figma',
    });

    ms.approve.mockResolvedValueOnce({ ok: true, completed: false, net: 283.33, title: 'Layout' });
    const first = await contractsService.approveMilestone(1, 7, 1);
    expect(first.completed).toBe(false);
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();

    ms.approve.mockResolvedValueOnce({ ok: true, completed: true, net: 283.34, title: 'Deploy' });
    const last = await contractsService.approveMilestone(1, 9, 1);
    expect(last.completed).toBe(true);
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(2, 1);
  });

  it('só o freelancer entrega e só o cliente aprova; marco fora de estado → 409', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    await expect(contractsService.deliverMilestone(1, 7, 1, 'x')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(contractsService.approveMilestone(1, 7, 2)).rejects.toMatchObject({
      statusCode: 403,
    });
    ms.approve.mockResolvedValue({ ok: false, completed: false, net: 0, title: '' });
    await expect(contractsService.approveMilestone(1, 7, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('aprovação tácita de marco só em contrato aberto', async () => {
    repo.findById.mockResolvedValue(row({ status: 'completed' }));
    expect(await contractsService.approveMilestoneTacitly(1, 7, 5)).toBe(false);
    expect(ms.approve).not.toHaveBeenCalled();
  });
});

describe('cancelamento por marcos liquida só o que ainda não foi liberado', () => {
  it('50% do restante volta ao cliente; marcos abertos ficam cancelados', async () => {
    repo.findById.mockResolvedValue(row({ status: 'in_progress' }));
    ms.escrowRemaining.mockResolvedValue({ price: 400, net: 340 }); // 600 já liberados
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r.refundPercentage).toBe(50);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        milestonesTo: { from: ['pending', 'funded', 'delivered'], to: 'cancelled' },
        walletEffects: [
          { userId: 2, pendingDelta: -340, balanceDelta: 170, reason: 'escrow_release' },
          { userId: 1, pendingDelta: 0, balanceDelta: 200, reason: 'refund' },
        ],
      }),
    );
  });
});
