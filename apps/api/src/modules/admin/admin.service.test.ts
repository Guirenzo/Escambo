import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../disputes/disputes.repository', () => ({
  disputesRepository: { findById: vi.fn(), listOpen: vi.fn(), resolve: vi.fn() },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../contracts/milestones.repository', () => ({
  milestonesRepository: { escrowRemaining: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../auth/auth.repository', () => ({
  authRepository: { findByUlid: vi.fn().mockResolvedValue({ id: 5 }) },
}));
vi.mock('../auth/session.repository', () => ({
  sessionRepository: { revokeAllForUser: vi.fn().mockResolvedValue(0) },
}));
vi.mock('./admin.repository', () => ({
  adminRepository: { setUserStatus: vi.fn(), recordAction: vi.fn(), metrics: vi.fn() },
}));

import { adminService } from './admin.service';
import { disputesRepository, type DisputeRow } from '../disputes/disputes.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { adminRepository } from './admin.repository';

const disputes = vi.mocked(disputesRepository);
const contracts = vi.mocked(contractsRepository);
const admin = vi.mocked(adminRepository);

const disputeRow = (o: Partial<{ status: string }> = {}): DisputeRow =>
  ({
    id: 1,
    ulid: '01DISPUTE',
    contract_id: 1,
    opened_by: 1,
    reason: 'quality',
    description: 'x',
    status: 'open',
    resolution: null,
    refund_percentage: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as DisputeRow;

const contractRow = (o: Partial<{ payment_mode: string; price: string; freelancer_net: string }> = {}): ContractRow =>
  ({
    id: 1,
    client_id: 1,
    freelancer_id: 2,
    price: '1000.00',
    freelancer_net: '850.00',
    payment_mode: 'cash',
    ...o,
  }) as unknown as ContractRow;

beforeEach(() => {
  vi.clearAllMocks();
  disputes.findById.mockResolvedValue(disputeRow());
  contracts.findById.mockResolvedValue(contractRow());
  disputes.resolve.mockResolvedValue(true);
});

describe('adminService.resolveDispute (escrow)', () => {
  it('release_freelancer libera o líquido e conclui', async () => {
    await adminService.resolveDispute(10, 1, { resolution: 'release_freelancer' });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'cash',
        clientId: 1,
        escrowNet: 850,
        releaseToFreelancer: 850,
        refundToClient: 0,
        contractFinalStatus: 'completed',
      }),
    );
  });

  it('refund_client estorna tudo e cancela', async () => {
    await adminService.resolveDispute(10, 1, { resolution: 'refund_client' });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseToFreelancer: 0,
        refundToClient: 1000, // o preço inteiro, inclusive a taxa
        contractFinalStatus: 'cancelled',
        refundPercentage: 100,
      }),
    );
  });

  it('partial_split libera proporcional (40% reembolso -> 60% ao freelancer)', async () => {
    await adminService.resolveDispute(10, 1, { resolution: 'partial_split', refundPercentage: 40 });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseToFreelancer: 510,
        refundToClient: 400,
        contractFinalStatus: 'completed',
        refundPercentage: 40,
      }),
    );
  });

  it('em créditos divide os créditos retidos, sem sobra de arredondamento', async () => {
    contracts.findById.mockResolvedValue(
      contractRow({ payment_mode: 'credits', price: '45.00', freelancer_net: '45.00' }),
    );
    await adminService.resolveDispute(10, 1, { resolution: 'partial_split', refundPercentage: 50 });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'credits',
        escrowNet: 45,
        releaseToFreelancer: 23,
        refundToClient: 22,
      }),
    );
  });

  it('409 se já resolvida', async () => {
    disputes.findById.mockResolvedValue(disputeRow({ status: 'resolved' }));
    await expect(
      adminService.resolveDispute(10, 1, { resolution: 'release_freelancer' }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('adminService.moderateUser', () => {
  it('bane o usuário e registra a ação', async () => {
    admin.setUserStatus.mockResolvedValue(true);
    admin.recordAction.mockResolvedValue(undefined);
    await adminService.moderateUser(10, '01HZXULIDEXAMPLE0000000000', 'ban');
    expect(admin.setUserStatus).toHaveBeenCalledWith('01HZXULIDEXAMPLE0000000000', 'banned');
    expect(admin.recordAction).toHaveBeenCalled();
  });

  it('404 quando o usuário não existe', async () => {
    admin.setUserStatus.mockResolvedValue(false);
    await expect(
      adminService.moderateUser(10, '01HZXULIDEXAMPLE0000000000', 'suspend'),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
