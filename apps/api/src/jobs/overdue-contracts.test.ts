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

import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { milestonesRepository } from '../modules/contracts/milestones.repository';
import { settingsRepository } from '../modules/settings/settings.repository';
import { setClockForTests } from '../utils/clock';
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
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');

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
    // Cada linha lida vai ao service uma vez, com a carência vigente e o instante da rodada.
    expect(svc.expireExtension.mock.calls).toEqual([[{ id: 8 }, 12, NOON]]);
    expect(svc.notifyOverdue.mock.calls).toEqual([
      [{ id: 1 }, 12, NOON],
      [{ id: 2 }, 12, NOON],
    ]);
    expect(svc.openOverdueDispute.mock.calls).toEqual([
      [{ id: 3 }, NOON],
      [{ id: 4 }, NOON],
    ]);
    // quem outra instância já avisou/disputou (false/null) não entra no resultado
    expect(result).toMatchObject({
      graceHours: 12,
      expired: [8],
      notified: [1],
      disputed: [3],
      milestones: [],
      failed: [],
    });
    // Só a disputa que ESTA rodada abriu é registrada, com o id dela.
    expect(info.mock.calls).toEqual([
      [{ contractId: 3, disputeId: 70 }, 'disputa aberta por prazo estourado (RN-029)'],
    ]);
    expect(error).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
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
    repo.findGraceEnded.mockImplementation(async () => {
      order.push('disputa');
      return [];
    });
    milestones.findOverdueUnnoticed.mockImplementation(async () => {
      order.push('marcos');
      return [];
    });
    await runOverdueContracts(NOON);
    // Fases 0, 1, 2 e 3, cada uma lida só depois de a anterior terminar.
    expect(order).toEqual(['expira', 'avisa', 'disputa', 'marcos']);
  });

  it('a fase 1 só lê o banco depois que a fase 0 terminou de expirar os pedidos', async () => {
    const order: string[] = [];
    repo.findExtensionsToExpire.mockResolvedValue([{ id: 8 }] as never);
    svc.expireExtension.mockImplementation(async () => {
      // Uma volta inteira do laço de eventos: se a fase 1 não esperasse, leria antes daqui.
      await new Promise((resolve) => setImmediate(resolve));
      order.push('pedido 8 expirado');
      return true;
    });
    repo.findOverdueUnnoticed.mockImplementation(async () => {
      order.push('leitura da fase 1');
      return [];
    });

    await runOverdueContracts(NOON);

    expect(order).toEqual(['pedido 8 expirado', 'leitura da fase 1']);
  });

  it('de noite em todos os fusos não consulta nada: nenhuma sanção de madrugada', async () => {
    const result = await runOverdueContracts(MIDNIGHT);
    expect(result).toEqual({
      graceHours: 12,
      zones: [],
      expired: [],
      notified: [],
      disputed: [],
      milestones: [],
      failed: [],
    });
    expect(repo.findExtensionsToExpire).not.toHaveBeenCalled();
    expect(repo.findOverdueUnnoticed).not.toHaveBeenCalled();
    expect(repo.findGraceEnded).not.toHaveBeenCalled();
    expect(milestones.findOverdueUnnoticed).not.toHaveBeenCalled();
    expect(svc.expireExtension).not.toHaveBeenCalled();
    expect(svc.notifyOverdue).not.toHaveBeenCalled();
    expect(svc.openOverdueDispute).not.toHaveBeenCalled();
    expect(svc.notifyMilestoneOverdue).not.toHaveBeenCalled();
  });

  it('só os fusos em que é dia vão para as consultas', async () => {
    const result = await runOverdueContracts(EARLY);
    expect(result.zones).toEqual(['America/Noronha', 'America/Sao_Paulo']);
    const day = ['America/Noronha', 'America/Sao_Paulo'];
    expect(repo.findExtensionsToExpire.mock.calls).toEqual([[EARLY, day]]);
    expect(repo.findOverdueUnnoticed.mock.calls).toEqual([[EARLY, day]]);
    expect(repo.findGraceEnded.mock.calls).toEqual([[EARLY, day]]);
    expect(milestones.findOverdueUnnoticed.mock.calls).toEqual([[EARLY, day]]);
  });

  it('fase 3 avisa marco nunca entregue com prazo vencido, uma vez por marco', async () => {
    milestones.findOverdueUnnoticed.mockResolvedValue([
      { id: 40, contract_id: 9 },
      { id: 41, contract_id: 9 },
    ] as never);
    svc.notifyMilestoneOverdue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await runOverdueContracts(NOON);

    // O aviso do marco não leva a carência: marco atrasado não abre disputa.
    expect(svc.notifyMilestoneOverdue.mock.calls).toEqual([
      [{ id: 40, contract_id: 9 }, NOON],
      [{ id: 41, contract_id: 9 }, NOON],
    ]);
    expect(result.milestones).toEqual([40]);
    expect(result.disputed).toEqual([]);
  });

  it('falha isolada não derruba a rodada', async () => {
    repo.findExtensionsToExpire.mockResolvedValue([{ id: 7 }] as never);
    repo.findOverdueUnnoticed.mockResolvedValue([{ id: 5 }] as never);
    repo.findGraceEnded.mockResolvedValue([{ id: 6 }] as never);
    const lock = new Error('lock');
    const smtp = new Error('smtp');
    svc.expireExtension.mockRejectedValue(lock);
    svc.notifyOverdue.mockRejectedValue(smtp);
    svc.openOverdueDispute.mockResolvedValue(9);
    const error = vi.spyOn(logger, 'error');

    const result = await runOverdueContracts(NOON);

    expect(result.failed).toEqual([7, 5]);
    expect(result.disputed).toEqual([6]);
    // Quem falhou não entra como expirado nem avisado.
    expect(result.expired).toEqual([]);
    expect(result.notified).toEqual([]);
    // Cada falha fica registrada com a contratação e o erro, dizendo em que fase foi.
    expect(error.mock.calls).toEqual([
      [{ contractId: 7, err: lock }, 'falha ao expirar pedido de extensão'],
      [{ contractId: 5, err: smtp }, 'falha ao avisar prazo estourado'],
    ]);
    error.mockRestore();
  });

  it('falha ao abrir a disputa de uma contratação não impede a disputa das outras (RN-029)', async () => {
    const error = vi.spyOn(logger, 'error');
    const boom = new Error('deadlock');
    repo.findGraceEnded.mockResolvedValue([{ id: 6 }, { id: 7 }] as never);
    svc.openOverdueDispute.mockRejectedValueOnce(boom).mockResolvedValueOnce(71);

    const result = await runOverdueContracts(NOON);

    expect(svc.openOverdueDispute).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([6]);
    expect(result.disputed).toEqual([7]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { contractId: 6, err: boom },
      'falha ao abrir disputa por prazo',
    );
    error.mockRestore();
  });

  it('falha ao avisar um marco entra em failed pela CONTRATAÇÃO dele, e os outros marcos são avisados', async () => {
    const error = vi.spyOn(logger, 'error');
    const boom = new Error('smtp');
    milestones.findOverdueUnnoticed.mockResolvedValue([
      { id: 40, contract_id: 9 },
      { id: 41, contract_id: 10 },
    ] as never);
    svc.notifyMilestoneOverdue.mockRejectedValueOnce(boom).mockResolvedValueOnce(true);

    const result = await runOverdueContracts(NOON);

    expect(milestones.findOverdueUnnoticed).toHaveBeenCalledWith(NOON, result.zones);
    expect(result.failed).toEqual([9]);
    expect(result.milestones).toEqual([41]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { contractId: 9, milestoneId: 40, err: boom },
      'falha ao avisar marco atrasado',
    );
    error.mockRestore();
  });

  it('sem hora informada, a rodada inteira usa o relógio do fluxo de prazos', async () => {
    setClockForTests(NOON, { frozen: true });
    try {
      repo.findGraceEnded.mockResolvedValue([{ id: 3 }] as never);
      svc.openOverdueDispute.mockResolvedValue(70);

      const result = await runOverdueContracts();

      expect(result.zones).toHaveLength(5);
      expect(repo.findExtensionsToExpire).toHaveBeenCalledWith(NOON, result.zones);
      expect(repo.findGraceEnded).toHaveBeenCalledWith(NOON, result.zones);
      expect(svc.openOverdueDispute).toHaveBeenCalledWith({ id: 3 }, NOON);
    } finally {
      setClockForTests(null);
    }
  });
});
