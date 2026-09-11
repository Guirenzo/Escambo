import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: { findOverdueUnnoticed: vi.fn(), findOverdueBeyondGrace: vi.fn() },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: { notifyOverdue: vi.fn(), openOverdueDispute: vi.fn() },
}));
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn() },
}));

import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { settingsRepository } from '../modules/settings/settings.repository';
import { DEFAULT_DEADLINE_GRACE_HOURS, runOverdueContracts } from './overdue-contracts';

const repo = vi.mocked(contractsRepository);
const svc = vi.mocked(contractsService);
const settings = vi.mocked(settingsRepository);

describe('job de prazo estourado (RN-029)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getNumber.mockResolvedValue(12);
    repo.findOverdueUnnoticed.mockResolvedValue([]);
    repo.findOverdueBeyondGrace.mockResolvedValue([]);
  });

  it('fase 1 avisa os vencidos sem aviso; fase 2 abre disputa dos que passaram da carência', async () => {
    repo.findOverdueUnnoticed.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
    repo.findOverdueBeyondGrace.mockResolvedValue([{ id: 3 }, { id: 4 }] as never);
    svc.notifyOverdue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    svc.openOverdueDispute.mockResolvedValueOnce(70).mockResolvedValueOnce(null);

    const result = await runOverdueContracts();

    expect(settings.getNumber).toHaveBeenCalledWith(
      'deadline_grace_hours',
      DEFAULT_DEADLINE_GRACE_HOURS,
    );
    expect(repo.findOverdueBeyondGrace).toHaveBeenCalledWith(12);
    expect(svc.notifyOverdue).toHaveBeenCalledWith({ id: 1 }, 12);
    expect(svc.openOverdueDispute).toHaveBeenCalledWith({ id: 3 }, 12);
    // quem outra instância já avisou/disputou (false/null) não entra no resultado
    expect(result).toEqual({ graceHours: 12, notified: [1], disputed: [3], failed: [] });
  });

  it('falha isolada não derruba a rodada', async () => {
    repo.findOverdueUnnoticed.mockResolvedValue([{ id: 5 }] as never);
    repo.findOverdueBeyondGrace.mockResolvedValue([{ id: 6 }] as never);
    svc.notifyOverdue.mockRejectedValue(new Error('smtp'));
    svc.openOverdueDispute.mockResolvedValue(9);

    const result = await runOverdueContracts();

    expect(result.failed).toEqual([5]);
    expect(result.disputed).toEqual([6]);
  });
});
