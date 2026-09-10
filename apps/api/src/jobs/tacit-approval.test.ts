import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: { findDeliveredOlderThan: vi.fn() },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: { approveTacitly: vi.fn(), approveMilestoneTacitly: vi.fn() },
}));
vi.mock('../modules/contracts/milestones.repository', () => ({
  milestonesRepository: { findDeliveredOlderThan: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn() },
}));

import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { milestonesRepository } from '../modules/contracts/milestones.repository';
import { settingsRepository } from '../modules/settings/settings.repository';
import { DEFAULT_TACIT_APPROVAL_DAYS, runTacitApproval } from './tacit-approval';

const repo = vi.mocked(contractsRepository);
const svc = vi.mocked(contractsService);
const settings = vi.mocked(settingsRepository);
const milestones = vi.mocked(milestonesRepository);

describe('job de aprovação tácita', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getNumber.mockResolvedValue(7);
    milestones.findDeliveredOlderThan.mockResolvedValue([]);
  });

  it('usa os dias da configuração da plataforma e aprova cada entrega vencida', async () => {
    repo.findDeliveredOlderThan.mockResolvedValue([{ id: 10 }, { id: 11 }] as never);
    svc.approveTacitly.mockResolvedValue({} as never);

    const result = await runTacitApproval();

    expect(settings.getNumber).toHaveBeenCalledWith(
      'tacit_approval_days',
      DEFAULT_TACIT_APPROVAL_DAYS,
    );
    expect(repo.findDeliveredOlderThan).toHaveBeenCalledWith(7);
    expect(svc.approveTacitly).toHaveBeenCalledTimes(2);
    expect(svc.approveTacitly).toHaveBeenCalledWith(10, 7);
    expect(result).toEqual({ days: 7, approved: [10, 11], failed: [], milestones: [] });
  });

  it('marcos entregues sem resposta também são aprovados (escrow por marcos)', async () => {
    repo.findDeliveredOlderThan.mockResolvedValue([]);
    milestones.findDeliveredOlderThan.mockResolvedValue([
      { id: 5, contract_id: 20, client_id: 1, freelancer_id: 2 },
      { id: 6, contract_id: 21, client_id: 1, freelancer_id: 2 },
    ] as never);
    svc.approveMilestoneTacitly.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('x'));

    const result = await runTacitApproval();

    expect(svc.approveMilestoneTacitly).toHaveBeenCalledWith(20, 5, 7);
    expect(result.milestones).toEqual([5]);
    expect(result.failed).toEqual([21]);
  });

  it('isola falhas: um contrato com erro não impede os outros', async () => {
    repo.findDeliveredOlderThan.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never);
    svc.approveTacitly
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('conflito'))
      .mockResolvedValueOnce({} as never);

    const result = await runTacitApproval();

    expect(result.approved).toEqual([1, 3]);
    expect(result.failed).toEqual([2]);
  });

  it('sem entregas vencidas não faz nada', async () => {
    repo.findDeliveredOlderThan.mockResolvedValue([]);
    const result = await runTacitApproval();
    expect(svc.approveTacitly).not.toHaveBeenCalled();
    expect(result.approved).toEqual([]);
  });
});
