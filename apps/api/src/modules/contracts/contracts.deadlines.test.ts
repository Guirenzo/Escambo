import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./contracts.repository', () => ({
  DEADLINE_ACTIVE_STATUSES: ['accepted', 'in_progress', 'revision_requested'],
  contractsRepository: {
    findById: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    transition: vi.fn(),
    requestExtension: vi.fn(),
    resolveExtension: vi.fn(),
    markOverdueNotified: vi.fn(),
  },
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    listForContract: vi.fn().mockResolvedValue([]),
    escrowRemaining: vi.fn(),
  },
}));
vi.mock('../wallet/wallet.service', () => ({ walletService: { ensure: vi.fn() } }));
vi.mock('../gamification/gamification.service', () => ({
  gamificationService: { onContractCompleted: vi.fn() },
}));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../disputes/disputes.repository', () => ({
  disputesRepository: { create: vi.fn() },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { notificationsService } from '../notifications/notifications.service';

const repo = vi.mocked(contractsRepository);
const disputes = vi.mocked(disputesRepository);
const notify = vi.mocked(notificationsService.notify);

const DAY = 86_400_000;
const inDays = (n: number): Date => new Date(Date.now() + n * DAY);

function row(o: Partial<Omit<ContractRow, 'constructor'>> = {}): ContractRow {
  return {
    id: 1,
    ulid: '01CONTRACT',
    client_id: 1,
    freelancer_id: 2,
    service_id: null,
    title: 'Vídeo institucional',
    description: 'Roteiro, captação e edição',
    price: '900.00',
    platform_fee: '135.00',
    freelancer_net: '765.00',
    status: 'accepted',
    payment_mode: 'cash',
    barter_agreement_id: null,
    deadline_at: inDays(5),
    extension_status: 'none',
    extension_deadline_at: null,
    extension_reason: null,
    extension_requested_at: null,
    extension_resolved_at: null,
    deadline_extended_at: null,
    overdue_notified_at: null,
    accepted_at: new Date(),
    completed_at: null,
    cancelled_at: null,
    created_at: inDays(-2),
    has_review: 0,
    has_milestones: 0,
    ...o,
  } as ContractRow;
}

const ask = (deadlineAt: Date = inDays(12)) => ({
  deadlineAt: deadlineAt.toISOString(),
  reason: 'O material do cliente chegou depois do combinado',
});

beforeEach(() => vi.clearAllMocks());

describe('requestExtension (RN-028)', () => {
  it('só o freelancer, só com prazo, só uma vez e só para um prazo maior e futuro', async () => {
    repo.findById.mockResolvedValue(row());
    await expect(contractsService.requestExtension(1, 1, ask())).rejects.toMatchObject({
      statusCode: 403,
    });

    repo.findById.mockResolvedValue(row({ deadline_at: null }));
    await expect(contractsService.requestExtension(1, 2, ask())).rejects.toMatchObject({
      code: 'no_deadline',
    });

    repo.findById.mockResolvedValue(row({ deadline_extended_at: new Date() }));
    await expect(contractsService.requestExtension(1, 2, ask())).rejects.toMatchObject({
      code: 'extension_used',
    });

    repo.findById.mockResolvedValue(
      row({ extension_status: 'pending', extension_deadline_at: inDays(9) }),
    );
    await expect(contractsService.requestExtension(1, 2, ask())).rejects.toMatchObject({
      code: 'extension_pending',
    });

    repo.findById.mockResolvedValue(row());
    await expect(contractsService.requestExtension(1, 2, ask(inDays(3)))).rejects.toMatchObject({
      code: 'invalid_deadline',
    });

    repo.findById.mockResolvedValue(row({ status: 'delivered' }));
    await expect(contractsService.requestExtension(1, 2, ask())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(repo.requestExtension).not.toHaveBeenCalled();
  });

  it('registra o pedido e devolve o contrato com a extensão pendente', async () => {
    const input = ask();
    repo.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(
      row({
        extension_status: 'pending',
        extension_deadline_at: new Date(input.deadlineAt),
        extension_reason: input.reason,
        extension_requested_at: new Date(),
      }),
    );
    repo.requestExtension.mockResolvedValue(true);

    const c = await contractsService.requestExtension(1, 2, input);

    expect(repo.requestExtension).toHaveBeenCalledWith({ id: 1, ...input });
    expect(c.extension).toMatchObject({ status: 'pending', reason: input.reason });
    expect(c.extension?.deadlineAt).toBe(new Date(input.deadlineAt).toISOString());
  });
});

describe('resolveExtension (RN-028)', () => {
  const pending = () =>
    row({
      extension_status: 'pending',
      extension_deadline_at: inDays(12),
      extension_reason: 'Atraso do material',
      extension_requested_at: new Date(),
    });

  it('só o cliente decide, e só quando há pedido pendente', async () => {
    repo.findById.mockResolvedValue(pending());
    await expect(contractsService.resolveExtension(1, 2, true)).rejects.toMatchObject({
      statusCode: 403,
    });
    repo.findById.mockResolvedValue(row());
    await expect(contractsService.resolveExtension(1, 1, true)).rejects.toMatchObject({
      code: 'no_pending_extension',
    });
    expect(repo.resolveExtension).not.toHaveBeenCalled();
  });

  it('aceitar grava a mudança de prazo na linha do tempo; recusar não', async () => {
    repo.findById.mockResolvedValue(pending());
    repo.resolveExtension.mockResolvedValue(true);

    await contractsService.resolveExtension(1, 1, true);
    expect(repo.resolveExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        accept: true,
        changedBy: 1,
        status: 'accepted',
        note: expect.stringContaining('Prazo estendido de'),
      }),
    );

    await contractsService.resolveExtension(1, 1, false);
    expect(repo.resolveExtension).toHaveBeenLastCalledWith(
      expect.objectContaining({ accept: false, note: null }),
    );
  });
});

describe('expireProposal (RN-021)', () => {
  it('cancela a proposta pendente devolvendo a reserva ao cliente e avisa as duas partes', async () => {
    repo.findById
      .mockResolvedValueOnce(row({ status: 'pending', accepted_at: null }))
      .mockResolvedValueOnce(row({ status: 'cancelled', accepted_at: null }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.expireProposal(1, 72);

    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        changedBy: 1,
        from: 'pending',
        to: 'cancelled',
        timestampColumn: 'cancelled_at',
        note: expect.stringContaining('RN-021'),
        walletEffects: [{ userId: 1, pendingDelta: -900, balanceDelta: 900, reason: 'refund' }],
      }),
    );
    expect(c.status).toBe('cancelled');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'contract_expired' }));
    expect(notify).toHaveBeenCalledWith(2, expect.objectContaining({ type: 'contract_expired' }));
  });

  it('não mexe em proposta que já saiu de pendente', async () => {
    repo.findById.mockResolvedValue(row({ status: 'accepted' }));
    await expect(contractsService.expireProposal(1, 72)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });
});

describe('prazo estourado (RN-029)', () => {
  it('avisa as duas partes uma vez só (a marca no banco é a trava)', async () => {
    repo.markOverdueNotified.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = row({ deadline_at: inDays(-1) });

    expect(await contractsService.notifyOverdue(r, 24)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(2, expect.objectContaining({ type: 'contract_overdue' }));
    expect(notify).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'contract_overdue' }));

    expect(await contractsService.notifyOverdue(r, 24)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('abre a disputa por prazo em nome do cliente e avisa os dois; sem transição, não avisa', async () => {
    const r = row({ deadline_at: inDays(-2), overdue_notified_at: inDays(-1) });
    disputes.create.mockResolvedValueOnce(77).mockResolvedValueOnce(null);

    expect(await contractsService.openOverdueDispute(r, 24)).toBe(77);
    expect(disputes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: 1,
        openedBy: 1,
        reason: 'deadline',
        description: expect.stringContaining('RN-029'),
      }),
    );
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'dispute_opened', data: { contractId: 1, disputeId: 77 } }),
    );

    expect(await contractsService.openOverdueDispute(r, 24)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
