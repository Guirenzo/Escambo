import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: { findApprovalDue: vi.fn() },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: { approveTacitly: vi.fn(), approveMilestonesTacitly: vi.fn() },
}));
vi.mock('../modules/contracts/milestones.repository', () => ({
  milestonesRepository: { findApprovalDue: vi.fn().mockResolvedValue([]) },
}));

import { logger } from '../config/logger';
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
  afterEach(() => vi.restoreAllMocks());

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

  describe('marcos entregues com a hora vencida (escrow por marcos, ADR 58)', () => {
    const due = (id: number, contractId: number) => ({
      id,
      contract_id: contractId,
      client_id: 1,
      freelancer_id: 2,
      approval_due_at: new Date('2026-10-01T12:00:00Z'),
    });

    it('os marcos da mesma contratação vão juntos (um aviso a cada parte), na ordem da consulta', async () => {
      const m5 = due(5, 20);
      const m6 = due(6, 21);
      const m7 = due(7, 20);
      milestones.findApprovalDue.mockResolvedValue([m5, m6, m7] as never);
      svc.approveMilestonesTacitly
        .mockResolvedValueOnce({ approved: [5, 7], failed: [] })
        .mockResolvedValueOnce({ approved: [6], failed: [] });

      const result = await runTacitApproval(NOON);

      expect(milestones.findApprovalDue).toHaveBeenCalledWith(NOON, result.zones);
      expect(svc.approveMilestonesTacitly.mock.calls).toEqual([
        [20, [m5, m7], NOON],
        [21, [m6], NOON],
      ]);
      expect(result).toMatchObject({ milestones: [5, 7, 6], failed: [] });
    });

    it('marco que falha dentro do grupo marca a contratação como falha, e os aprovados contam', async () => {
      milestones.findApprovalDue.mockResolvedValue([due(5, 20), due(7, 20)] as never);
      svc.approveMilestonesTacitly.mockResolvedValueOnce({ approved: [5], failed: [7] });

      const result = await runTacitApproval(NOON);

      expect(result.milestones).toEqual([5]);
      expect(result.failed).toEqual([20]);
    });

    it('o grupo que lança não impede os outros: registra a contratação e segue', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const boom = new Error('conexão perdida');
      milestones.findApprovalDue.mockResolvedValue([due(5, 20), due(6, 21)] as never);
      svc.approveMilestonesTacitly
        .mockRejectedValueOnce(boom)
        .mockResolvedValueOnce({ approved: [6], failed: [] });

      const result = await runTacitApproval(NOON);

      expect(result.milestones).toEqual([6]);
      expect(result.failed).toEqual([20]);
      expect(warn.mock.calls).toEqual([
        [{ err: boom, contractId: 20 }, 'aprovação tácita dos marcos falhou'],
      ]);
    });
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
    expect(svc.approveMilestonesTacitly).not.toHaveBeenCalled();
  });
});
