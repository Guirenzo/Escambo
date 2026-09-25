import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: { feeRate: vi.fn().mockResolvedValue(0.15) },
}));

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
vi.mock('../auth/user-zone', () => ({
  userZone: vi.fn().mockResolvedValue('America/Sao_Paulo'),
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn().mockResolvedValue(24) },
}));

import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { notificationsService } from '../notifications/notifications.service';
import { userZone } from '../auth/user-zone';
import { settingsRepository } from '../settings/settings.repository';
import type { Contract } from '@escambo/types';

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
    // Só a cópia de quem entrega pode sair no "não perturbe" (ADR 56); a do cliente vai sem opções.
    expect(notify).toHaveBeenCalledWith(2, expect.objectContaining({ type: 'contract_overdue' }), {
      passCategory: 'deadline',
    });
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

/** Os avisos de prazo com hora-limite no fuso de quem lê e a categoria do silêncio (ADR 56). */
describe('avisos de prazo com hora-limite (ADR 56)', () => {
  const zone = vi.mocked(userZone);
  const grace = vi.mocked(settingsRepository.getNumber);
  const NOW = new Date('2026-09-26T03:03:00Z'); // 00:03 em Brasília

  it('prazo estourado: cada cópia no fuso de quem lê; por marcos com a extensão usada não sai no silêncio', async () => {
    repo.markOverdueNotified.mockResolvedValue(true);
    zone.mockImplementation(async (id: number) =>
      id === 2 ? 'America/Manaus' : 'America/Sao_Paulo',
    );
    await contractsService.notifyOverdue(
      row({ deadline_at: new Date('2026-09-26T02:59:59Z') }),
      24,
      NOW,
    );
    const [freela, cliente] = [notify.mock.calls[0]!, notify.mock.calls[1]!];
    expect(freela[1].body).toBe(
      'Até 26/09/2026 às 23:03: entregue ou peça a extensão (uma vez), senão a mediação abre sozinha. O prazo era 25/09/2026.',
    );
    expect(freela[2]).toEqual({ passCategory: 'deadline' });
    expect(cliente[1].body).toContain('até 27/09/2026 às 00:03');
    expect(cliente[1].body).toContain('O prazo era 25/09/2026');
    expect(cliente).toHaveLength(2);

    notify.mockClear();
    zone.mockResolvedValue('America/Sao_Paulo');
    await contractsService.notifyOverdue(
      row({
        has_milestones: 1,
        deadline_extended_at: new Date(),
        deadline_at: new Date('2026-09-26T02:59:59Z'),
      }),
      24,
      NOW,
    );
    expect(notify.mock.calls[0]![1].body).toContain('Sem extensão possível');
    expect(notify.mock.calls[0]![2]).toEqual({});
  });

  const contract = (o: Partial<Contract> = {}): Contract =>
    ({
      id: 1,
      clientId: 1,
      freelancerId: 2,
      title: 'Vídeo institucional',
      status: 'revision_requested',
      deadlineAt: '2026-09-25T02:59:59.000Z',
      overdueNotifiedAt: '2026-09-25T03:00:00.000Z',
      deadlineExtendedAt: null,
      hasMilestones: false,
      extension: null,
      ...o,
    }) as Contract;

  it('revisão com a carência correndo: hora-limite e categoria; lida a carência do painel', async () => {
    zone.mockResolvedValue('America/Sao_Paulo');
    grace.mockResolvedValue(24);
    await contractsService.notifyFreelancerDeadline(
      'revision',
      contract(),
      new Date('2026-09-25T20:00:00Z'),
    );
    expect(grace).toHaveBeenCalledWith('deadline_grace_hours', 24);
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'contract_revision',
        title: 'Revisão pedida: Vídeo institucional',
        body: expect.stringMatching(/^Prazo vencido\. Até 26\/09\/2026 às 00:00:/),
      }),
      { passCategory: 'deadline' },
    );
  });

  it('recusa com o prazo no futuro: o aviso de sempre, sem categoria', async () => {
    zone.mockResolvedValue('America/Sao_Paulo');
    await contractsService.notifyFreelancerDeadline(
      'extension_declined',
      contract({
        status: 'in_progress',
        deadlineAt: '2026-10-10T02:59:59.000Z',
        overdueNotifiedAt: null,
      }),
      new Date('2026-09-25T20:00:00Z'),
    );
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ title: 'Extensão de prazo recusada' }),
      {},
    );
  });

  it('a leitura da carência falha: vai o texto de sempre, sem categoria, e nada lança', async () => {
    grace.mockRejectedValueOnce(new Error('db fora'));
    await expect(
      contractsService.notifyFreelancerDeadline(
        'revision',
        contract(),
        new Date('2026-09-25T20:00:00Z'),
      ),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toMatchObject({ title: 'Revisão solicitada' });
    expect(notify.mock.calls[0]).toHaveLength(2);
  });
});
