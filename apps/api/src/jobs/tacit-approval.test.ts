import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: { findApprovalDue: vi.fn() },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: { approveTacitly: vi.fn(), approveMilestoneTacitly: vi.fn() },
}));
vi.mock('../modules/contracts/milestones.repository', () => ({
  milestonesRepository: { findApprovalDue: vi.fn().mockResolvedValue([]) },
}));

import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { milestonesRepository } from '../modules/contracts/milestones.repository';
import { runTacitApproval } from './tacit-approval';

const repo = vi.mocked(contractsRepository);
const svc = vi.mocked(contractsService);
const milestones = vi.mocked(milestonesRepository);

const NOON = new Date('2026-10-01T15:00:00Z');
const MIDNIGHT = new Date('2026-10-02T03:00:00Z');

describe('job de aprovação tácita (RN-024, ADR 57)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.findApprovalDue.mockResolvedValue([]);
    milestones.findApprovalDue.mockResolvedValue([]);
  });

  it('aprova cada entrega com a hora gravada vencida, no mesmo instante da rodada', async () => {
    repo.findApprovalDue.mockResolvedValue([{ id: 10 }, { id: 11 }] as never);
    svc.approveTacitly.mockResolvedValue({} as never);

    const result = await runTacitApproval(NOON);

    expect(repo.findApprovalDue).toHaveBeenCalledWith(NOON, result.zones);
    expect(result.zones).toHaveLength(5);
    expect(svc.approveTacitly).toHaveBeenCalledTimes(2);
    expect(svc.approveTacitly).toHaveBeenCalledWith(10, NOON);
    expect(result).toMatchObject({ approved: [10, 11], failed: [], milestones: [] });
  });

  it('marcos entregues com a hora vencida também são aprovados (escrow por marcos)', async () => {
    const m5 = { id: 5, contract_id: 20, client_id: 1, freelancer_id: 2 };
    milestones.findApprovalDue.mockResolvedValue([
      m5,
      { id: 6, contract_id: 21, client_id: 1, freelancer_id: 2 },
    ] as never);
    svc.approveMilestoneTacitly.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('x'));

    const result = await runTacitApproval(NOON);

    expect(svc.approveMilestoneTacitly).toHaveBeenCalledWith(m5, NOON);
    expect(result.milestones).toEqual([5]);
    expect(result.failed).toEqual([21]);
  });

  it('isola falhas: um contrato com erro não impede os outros', async () => {
    repo.findApprovalDue.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never);
    svc.approveTacitly
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('conflito'))
      .mockResolvedValueOnce({} as never);

    const result = await runTacitApproval(NOON);

    expect(result.approved).toEqual([1, 3]);
    expect(result.failed).toEqual([2]);
  });

  it('de noite em todos os fusos não aprova nada nem consulta', async () => {
    const result = await runTacitApproval(MIDNIGHT);
    expect(result.zones).toEqual([]);
    expect(repo.findApprovalDue).not.toHaveBeenCalled();
    expect(milestones.findApprovalDue).not.toHaveBeenCalled();
    expect(svc.approveTacitly).not.toHaveBeenCalled();
  });
});
