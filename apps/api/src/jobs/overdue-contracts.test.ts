import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/contracts/contracts.repository', () => ({
  contractsRepository: {
    findExtensionsToExpire: vi.fn(),
    findOverdueUnnoticed: vi.fn(),
    findGraceEnded: vi.fn(),
  },
}));
vi.mock('../modules/contracts/contracts.service', () => ({
  contractsService: {
    expireExtension: vi.fn(),
    notifyOverdue: vi.fn(),
    openOverdueDispute: vi.fn(),
    notifyMilestoneOverdue: vi.fn(),
  },
}));
vi.mock('../modules/contracts/milestones.repository', () => ({
  milestonesRepository: { findOverdueUnnoticed: vi.fn() },
}));
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn() },
}));

import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { milestonesRepository } from '../modules/contracts/milestones.repository';
import { settingsRepository } from '../modules/settings/settings.repository';
import { DEFAULT_DEADLINE_GRACE_HOURS, runOverdueContracts } from './overdue-contracts';

const repo = vi.mocked(contractsRepository);
const svc = vi.mocked(contractsService);
const settings = vi.mocked(settingsRepository);
const milestones = vi.mocked(milestonesRepository);

/** 12:00 em Brasília: é dia nos 5 fusos (13h em Noronha, 10h em Rio Branco). */
const NOON = new Date('2026-10-01T15:00:00Z');
/** 00:00 em Brasília: noite nos 5 fusos. */
const MIDNIGHT = new Date('2026-10-02T03:00:00Z');
/** 09:30 em Brasília: dia em Noronha e Brasília; 08:30 em Manaus e 07:30 em Rio Branco. */
const EARLY = new Date('2026-10-01T12:30:00Z');

describe('job de prazo estourado (RN-028/RN-029, ADR 57)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getNumber.mockResolvedValue(12);
    repo.findExtensionsToExpire.mockResolvedValue([]);
    repo.findOverdueUnnoticed.mockResolvedValue([]);
    repo.findGraceEnded.mockResolvedValue([]);
    milestones.findOverdueUnnoticed.mockResolvedValue([]);
  });

  it('fase 0 expira pedidos, fase 1 avisa, fase 2 abre disputa, todas com o mesmo instante', async () => {
    repo.findExtensionsToExpire.mockResolvedValue([{ id: 8 }] as never);
    repo.findOverdueUnnoticed.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
    repo.findGraceEnded.mockResolvedValue([{ id: 3 }, { id: 4 }] as never);
    svc.expireExtension.mockResolvedValue(true);
    svc.notifyOverdue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    svc.openOverdueDispute.mockResolvedValueOnce(70).mockResolvedValueOnce(null);

    const result = await runOverdueContracts(NOON);

    expect(settings.getNumber).toHaveBeenCalledWith(
      'deadline_grace_hours',
      DEFAULT_DEADLINE_GRACE_HOURS,
    );
    const zones = result.zones;
    expect(zones).toHaveLength(5);
    expect(repo.findExtensionsToExpire).toHaveBeenCalledWith(NOON, zones);
    expect(repo.findOverdueUnnoticed).toHaveBeenCalledWith(NOON, zones);
    expect(repo.findGraceEnded).toHaveBeenCalledWith(NOON, zones);
    expect(svc.expireExtension).toHaveBeenCalledWith({ id: 8 }, 12, NOON);
    expect(svc.notifyOverdue).toHaveBeenCalledWith({ id: 1 }, 12, NOON);
    expect(svc.openOverdueDispute).toHaveBeenCalledWith({ id: 3 }, NOON);
    // quem outra instância já avisou/disputou (false/null) não entra no resultado
    expect(result).toMatchObject({
      graceHours: 12,
      expired: [8],
      notified: [1],
      disputed: [3],
      milestones: [],
      failed: [],
    });
  });

  it('a expiração do pedido vem antes do aviso: a recusa tácita pode liberar a fase 1', async () => {
    const order: string[] = [];
    repo.findExtensionsToExpire.mockImplementation(async () => {
      order.push('expira');
      return [];
    });
    repo.findOverdueUnnoticed.mockImplementation(async () => {
      order.push('avisa');
      return [];
    });
    await runOverdueContracts(NOON);
    expect(order).toEqual(['expira', 'avisa']);
  });

  it('de noite em todos os fusos não consulta nada: nenhuma sanção de madrugada', async () => {
    const result = await runOverdueContracts(MIDNIGHT);
    expect(result.zones).toEqual([]);
    expect(repo.findExtensionsToExpire).not.toHaveBeenCalled();
    expect(repo.findOverdueUnnoticed).not.toHaveBeenCalled();
    expect(repo.findGraceEnded).not.toHaveBeenCalled();
    expect(milestones.findOverdueUnnoticed).not.toHaveBeenCalled();
  });

  it('só os fusos em que é dia vão para as consultas', async () => {
    const result = await runOverdueContracts(EARLY);
    expect(result.zones).toEqual(['America/Noronha', 'America/Sao_Paulo']);
    expect(repo.findOverdueUnnoticed).toHaveBeenCalledWith(EARLY, [
      'America/Noronha',
      'America/Sao_Paulo',
    ]);
  });

  it('fase 3 avisa marco nunca entregue com prazo vencido, uma vez por marco', async () => {
    milestones.findOverdueUnnoticed.mockResolvedValue([
      { id: 40, contract_id: 9 },
      { id: 41, contract_id: 9 },
    ] as never);
    svc.notifyMilestoneOverdue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await runOverdueContracts(NOON);

    expect(svc.notifyMilestoneOverdue).toHaveBeenCalledTimes(2);
    expect(svc.notifyMilestoneOverdue).toHaveBeenCalledWith({ id: 40, contract_id: 9 }, NOON);
    expect(result.milestones).toEqual([40]);
    expect(result.disputed).toEqual([]);
  });

  it('falha isolada não derruba a rodada', async () => {
    repo.findExtensionsToExpire.mockResolvedValue([{ id: 7 }] as never);
    repo.findOverdueUnnoticed.mockResolvedValue([{ id: 5 }] as never);
    repo.findGraceEnded.mockResolvedValue([{ id: 6 }] as never);
    svc.expireExtension.mockRejectedValue(new Error('lock'));
    svc.notifyOverdue.mockRejectedValue(new Error('smtp'));
    svc.openOverdueDispute.mockResolvedValue(9);

    const result = await runOverdueContracts(NOON);

    expect(result.failed).toEqual([7, 5]);
    expect(result.disputed).toEqual([6]);
  });
});
