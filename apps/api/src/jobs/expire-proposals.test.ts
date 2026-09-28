import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: { findProposalsDue: vi.fn() },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: { expireProposal: vi.fn() },
}));

import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { runExpireProposals } from './expire-proposals';

const repo = vi.mocked(contractsRepository);
const svc = vi.mocked(contractsService);

const NOON = new Date('2026-10-01T15:00:00Z');
const MIDNIGHT = new Date('2026-10-02T03:00:00Z');

describe('job de expiração de propostas (RN-021, ADR 57)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('expira cada proposta com a validade gravada vencida, no instante da rodada', async () => {
    repo.findProposalsDue.mockResolvedValue([{ id: 10 }, { id: 11 }] as never);
    svc.expireProposal.mockResolvedValue({} as never);

    const result = await runExpireProposals(NOON);

    expect(repo.findProposalsDue).toHaveBeenCalledWith(NOON, result.zones);
    expect(svc.expireProposal).toHaveBeenCalledWith(10, NOON);
    expect(svc.expireProposal).toHaveBeenCalledWith(11, NOON);
    expect(result).toMatchObject({ expired: [10, 11], failed: [] });
  });

  it('uma falha não interrompe as demais', async () => {
    repo.findProposalsDue.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never);
    svc.expireProposal
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('conflito'))
      .mockResolvedValueOnce({} as never);

    const result = await runExpireProposals(NOON);

    expect(result.expired).toEqual([1, 3]);
    expect(result.failed).toEqual([2]);
  });

  it('de noite em todos os fusos não expira nada', async () => {
    const result = await runExpireProposals(MIDNIGHT);
    expect(result).toEqual({ zones: [], expired: [], failed: [] });
    expect(repo.findProposalsDue).not.toHaveBeenCalled();
  });
});
