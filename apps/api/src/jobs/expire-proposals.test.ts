import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: { findPendingOlderThan: vi.fn() },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: { expireProposal: vi.fn() },
}));
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn() },
}));

import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { settingsRepository } from '../modules/settings/settings.repository';
import { DEFAULT_PROPOSAL_EXPIRY_HOURS, runExpireProposals } from './expire-proposals';

const repo = vi.mocked(contractsRepository);
const svc = vi.mocked(contractsService);
const settings = vi.mocked(settingsRepository);

describe('job de expiração de propostas (RN-021)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getNumber.mockResolvedValue(48);
  });

  it('usa as horas da configuração e expira cada proposta parada', async () => {
    repo.findPendingOlderThan.mockResolvedValue([{ id: 10 }, { id: 11 }] as never);
    svc.expireProposal.mockResolvedValue({} as never);

    const result = await runExpireProposals();

    expect(settings.getNumber).toHaveBeenCalledWith(
      'proposal_expiry_hours',
      DEFAULT_PROPOSAL_EXPIRY_HOURS,
    );
    expect(repo.findPendingOlderThan).toHaveBeenCalledWith(48);
    expect(svc.expireProposal).toHaveBeenCalledWith(10, 48);
    expect(svc.expireProposal).toHaveBeenCalledWith(11, 48);
    expect(result).toEqual({ hours: 48, expired: [10, 11], failed: [] });
  });

  it('uma falha não interrompe as demais', async () => {
    repo.findPendingOlderThan.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never);
    svc.expireProposal
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('conflito'))
      .mockResolvedValueOnce({} as never);

    const result = await runExpireProposals();

    expect(result.expired).toEqual([1, 3]);
    expect(result.failed).toEqual([2]);
  });
});
