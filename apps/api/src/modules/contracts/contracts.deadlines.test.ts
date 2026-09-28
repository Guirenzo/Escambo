import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: {
    feeRate: vi.fn().mockResolvedValue(0.15),
    number: vi.fn().mockResolvedValue(24),
  },
}));

vi.mock('./contracts.repository', () => ({
  OVERDUE_DISPUTE_GUARD: 'AND guarda_da_disputa',
  contractsRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    transition: vi.fn(),
    requestExtension: vi.fn(),
    acceptExtension: vi.fn(),
    settleExtension: vi.fn(),
    markOverdueNotified: vi.fn(),
  },
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    listForContract: vi.fn().mockResolvedValue([]),
    escrowRemaining: vi.fn(),
    titlesByDelivery: vi.fn().mockResolvedValue({ delivered: [], missing: [] }),
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

import { setClockForTests } from '../../utils/clock';
import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { milestonesRepository } from './milestones.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { notificationsService } from '../notifications/notifications.service';
import { settingsRepository } from '../settings/settings.repository';

const repo = vi.mocked(contractsRepository);
const disputes = vi.mocked(disputesRepository);
const notify = vi.mocked(notificationsService.notify);
const settings = vi.mocked(settingsRepository.getNumber);

/** Horário de Brasília (UTC−3). */
const brt = (s: string): Date => new Date(`${s.replace(' ', 'T')}-03:00`);
/** Terça, 12:00 em Brasília: dia em todos os fusos. */
const NOW = brt('2026-10-06 12:00:00');

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
    deadline_at: brt('2026-10-09 23:59:59'),
    extension_status: 'none',
    extension_requests: 0,
    extension_deadline_at: null,
    extension_reason: null,
    extension_requested_at: null,
    extension_respond_by: null,
    extension_resolved_at: null,
    deadline_extended_at: null,
    overdue_notified_at: null,
    grace_ends_at: null,
    approval_due_at: null,
    proposal_expires_at: null,
    accepted_at: brt('2026-10-05 10:00:00'),
    completed_at: null,
    cancelled_at: null,
    created_at: brt('2026-10-04 10:00:00'),
    has_review: 0,
    has_milestones: 0,
    total_milestones: 0,
    undelivered_milestones: 0,
    delivered_awaiting: 0,
    in_revision: 0,
    deliveries_count: 0,
    first_delivered_at: null,
    freelancer_timezone: 'America/Sao_Paulo',
    client_timezone: 'America/Sao_Paulo',
    ...o,
  } as ContractRow;
}

const ask = (deadlineAt: Date = brt('2026-10-16 23:59:59')) => ({
  deadlineAt: deadlineAt.toISOString(),
  reason: 'O material do cliente chegou depois do combinado',
});

beforeEach(() => {
  vi.clearAllMocks();
  setClockForTests(NOW, { frozen: true });
  settings.mockResolvedValue(24);
});
afterEach(() => setClockForTests(null));

describe('requestExtension (RN-028, ADR 57)', () => {
  const codeOf = async (r: ContractRow, uid = 2, input = ask()) => {
    repo.findById.mockResolvedValue(r);
    return contractsService.requestExtension(1, uid, input).then(
      () => 'ok',
      (e: { code?: string; statusCode?: number }) => e.code ?? String(e.statusCode),
    );
  };

  it('cada regra tem o seu código', async () => {
    expect(await codeOf(row(), 1)).toBe('forbidden');
    expect(await codeOf(row({ deadline_at: null }))).toBe('no_deadline');
    expect(await codeOf(row({ status: 'delivered' }))).toBe('extension_after_delivery');
    expect(await codeOf(row({ status: 'revision_requested' }))).toBe('extension_after_delivery');
    expect(
      await codeOf(row({ has_milestones: 1, total_milestones: 2, undelivered_milestones: 0 })),
    ).toBe('extension_after_delivery');
    expect(await codeOf(row({ deadline_extended_at: NOW }))).toBe('extension_used');
    expect(
      await codeOf(
        row({ extension_status: 'pending', extension_deadline_at: brt('2026-10-12 23:59:59') }),
      ),
    ).toBe('extension_pending');
    expect(await codeOf(row({ extension_status: 'declined', extension_requests: 2 }))).toBe(
      'extension_limit',
    );
    expect(await codeOf(row({ grace_ends_at: brt('2026-10-06 11:00:00') }))).toBe('grace_over');
    expect(await codeOf(row(), 2, ask(brt('2026-10-08 23:59:59')))).toBe('invalid_deadline');
    // prazo já vencido: pedir uma data que o cliente não consegue decidir a tempo
    expect(
      await codeOf(
        row({ deadline_at: brt('2026-10-05 23:59:59') }),
        2,
        ask(brt('2026-10-06 20:00:00')),
      ),
    ).toBe('extension_too_close');
    expect(repo.requestExtension).not.toHaveBeenCalled();
  });

  it('registra com a hora de resposta do cliente e o avisa até quando responder', async () => {
    const input = ask();
    repo.findById.mockResolvedValue(row());
    repo.requestExtension.mockResolvedValue(true);

    await contractsService.requestExtension(1, 2, input);

    expect(repo.requestExtension).toHaveBeenCalledWith({
      id: 1,
      deadlineAt: new Date(input.deadlineAt),
      reason: input.reason,
      now: NOW,
      respondBy: brt('2026-10-08 12:00:00'),
    });
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'deadline_extension_requested',
        body: expect.stringMatching(
          /^Responda até qui, 08\/10 às 12:00: novo prazo proposto 16\/10\/2026\./,
        ),
      }),
      {},
    );
  });

  it('corrida: o UPDATE não pegou → 409 e nenhum aviso', async () => {
    repo.findById.mockResolvedValue(row());
    repo.requestExtension.mockResolvedValue(false);
    await expect(contractsService.requestExtension(1, 2, ask())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('resolveExtension (RN-028, ADR 57)', () => {
  const pending = (o: Partial<Omit<ContractRow, 'constructor'>> = {}) =>
    row({
      extension_status: 'pending',
      extension_requests: 1,
      extension_deadline_at: brt('2026-10-16 23:59:59'),
      extension_reason: 'Atraso do material',
      extension_requested_at: brt('2026-10-06 10:00:00'),
      extension_respond_by: brt('2026-10-08 10:00:00'),
      ...o,
    });

  it('só o cliente decide, só o pedido que viu e só dentro da hora', async () => {
    repo.findById.mockResolvedValue(pending());
    await expect(contractsService.resolveExtension(1, 2, true)).rejects.toMatchObject({
      statusCode: 403,
    });
    repo.findById.mockResolvedValue(row());
    await expect(contractsService.resolveExtension(1, 1, true)).rejects.toMatchObject({
      code: 'no_pending_extension',
    });
    repo.findById.mockResolvedValue(pending());
    await expect(contractsService.resolveExtension(1, 1, true, 2)).rejects.toMatchObject({
      code: 'extension_changed',
    });
    repo.findById.mockResolvedValue(pending({ extension_respond_by: brt('2026-10-06 11:59:00') }));
    await expect(contractsService.resolveExtension(1, 1, false)).rejects.toMatchObject({
      code: 'extension_expired',
      message: 'O prazo para responder a este pedido acabou ter, 06/10 às 11:59; ele expirou.',
    });
    repo.findById.mockResolvedValue(pending({ extension_deadline_at: brt('2026-10-06 11:00:00') }));
    await expect(contractsService.resolveExtension(1, 1, true)).rejects.toMatchObject({
      code: 'extension_stale',
    });
    expect(repo.acceptExtension).not.toHaveBeenCalled();
    expect(repo.settleExtension).not.toHaveBeenCalled();
  });

  it('aceitar grava a mudança na linha do tempo, pelo número do pedido', async () => {
    repo.findById.mockResolvedValue(pending());
    repo.acceptExtension.mockResolvedValue(true);
    await contractsService.resolveExtension(1, 1, true, 1);
    expect(repo.acceptExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        seq: 1,
        now: NOW,
        changedBy: 1,
        status: 'accepted',
        note: expect.stringContaining('Prazo estendido de'),
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'deadline_extension_accepted',
        title: 'Extensão aceita: novo prazo 16/10/2026',
      }),
      {},
    );
  });

  it('recusar com o aviso dado devolve a carência de onde parou e avisa sem furar o silêncio', async () => {
    const r = pending({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:00:00'),
      grace_ends_at: brt('2026-10-06 18:00:00'),
      extension_requested_at: brt('2026-10-06 10:00:00'),
    });
    repo.findById.mockResolvedValueOnce(r).mockResolvedValue({
      ...r,
      extension_status: 'declined',
      grace_ends_at: brt('2026-10-07 09:00:00'),
    } as ContractRow);
    repo.settleExtension.mockResolvedValue(true);

    await contractsService.resolveExtension(1, 1, false, 1);

    // 18:00 + 2 h de pausa = 20:00; o piso de 6 h de dia a partir de 12:00 vai a 18:00; as 12 h de
    // relógio a 00:00 → 09:00 do dia seguinte
    expect(repo.settleExtension).toHaveBeenCalledWith({
      id: 1,
      seq: 1,
      outcome: 'declined',
      now: NOW,
      graceEndsAt: brt('2026-10-07 09:00:00'),
    });
    const [uid, params, opts] = notify.mock.calls[0]!;
    expect(uid).toBe(2);
    expect(params).toMatchObject({
      type: 'deadline_extension_declined',
      title: 'Extensão recusada: Vídeo institucional',
      body: 'Prazo vencido. Até qua, 07/10 às 09:00: entregue ou peça a extensão, senão a disputa abre sozinha. O prazo era 02/10/2026. Você ainda pode fazer mais um pedido.',
    });
    expect(opts).toEqual({});
  });
});

describe('expireExtension (job, ADR 57)', () => {
  it('expira como recusa e avisa as duas partes', async () => {
    const r = row({
      extension_status: 'pending',
      extension_requests: 1,
      extension_deadline_at: brt('2026-10-16 23:59:59'),
      extension_requested_at: brt('2026-10-04 10:00:00'),
      extension_respond_by: brt('2026-10-06 10:00:00'),
    });
    repo.findById.mockResolvedValue({ ...r, extension_status: 'expired' } as ContractRow);
    repo.settleExtension.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await contractsService.expireExtension(r, 24, NOW)).toBe(true);
    expect(repo.settleExtension).toHaveBeenCalledWith({
      id: 1,
      seq: 1,
      outcome: 'expired',
      now: NOW,
      graceEndsAt: null,
    });
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'deadline_extension_expired',
        body: 'Vale o prazo atual, 09/10/2026. O cliente não respondeu até ter, 06/10 às 10:00. Você ainda pode fazer mais um pedido.',
      }),
      {},
    );
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'deadline_extension_expired',
        title: 'Pedido de extensão expirou: Vídeo institucional',
      }),
      {},
    );

    notify.mockClear();
    expect(await contractsService.expireExtension(r, 24, NOW)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('expireProposal (RN-021)', () => {
  it('cancela na hora gravada, devolve a reserva e avisa as duas partes', async () => {
    repo.findById
      .mockResolvedValueOnce(
        row({
          status: 'pending',
          accepted_at: null,
          proposal_expires_at: brt('2026-10-06 11:00:00'),
        }),
      )
      .mockResolvedValueOnce(row({ status: 'cancelled', accepted_at: null }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.expireProposal(1, NOW);

    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        changedBy: 1,
        from: 'pending',
        to: 'cancelled',
        timestampColumn: 'cancelled_at',
        now: NOW,
        guard: { sql: expect.stringContaining('c.proposal_expires_at <= :now') },
        note: expect.stringContaining('RN-021'),
        walletEffects: [{ userId: 1, pendingDelta: -900, balanceDelta: 900, reason: 'refund' }],
      }),
    );
    expect(c.status).toBe('cancelled');
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'contract_expired',
        body: 'Vídeo institucional: o freelancer não respondeu até ter, 06/10 às 11:00. O valor reservado voltou para a sua carteira.',
      }),
      {},
    );
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'contract_expired' }),
      {},
    );
  });

  it('não mexe em proposta que já saiu de pendente', async () => {
    repo.findById.mockResolvedValue(row({ status: 'accepted' }));
    await expect(contractsService.expireProposal(1, NOW)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });
});

describe('prazo estourado (RN-029, ADR 57)', () => {
  it('não avisa antes das 9h depois do prazo, mesmo que o job rode', async () => {
    const r = row({ deadline_at: brt('2026-10-05 23:59:59') });
    expect(await contractsService.notifyOverdue(r, 24, brt('2026-10-06 08:30:00'))).toBe(false);
    expect(repo.markOverdueNotified).not.toHaveBeenCalled();
  });

  it('prazo às 20:45: às 20:50 não avisa (a Sala prometeu as 9h); às 9h seguintes avisa', async () => {
    const r = row({ deadline_at: brt('2026-10-05 20:45:00') });
    expect(await contractsService.notifyOverdue(r, 24, brt('2026-10-05 20:50:00'))).toBe(false);
    repo.markOverdueNotified.mockResolvedValue(true);
    expect(await contractsService.notifyOverdue(r, 24, brt('2026-10-06 09:00:00'))).toBe(true);
  });

  it('grava o fim da carência e avisa as duas partes uma vez; só a cópia de quem entrega fura o silêncio', async () => {
    repo.markOverdueNotified.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = row({
      deadline_at: brt('2026-10-05 23:59:59'),
      freelancer_timezone: 'America/Manaus',
    });
    const at = brt('2026-10-06 10:03:00.400'); // 09:03 em Manaus

    expect(await contractsService.notifyOverdue(r, 24, at)).toBe(true);
    expect(repo.markOverdueNotified).toHaveBeenCalledWith({
      id: 1,
      deadlineAt: r.deadline_at,
      now: brt('2026-10-06 10:03:00'),
      graceEndsAt: brt('2026-10-07 10:03:00'),
    });
    const [freela, cliente] = [notify.mock.calls[0]!, notify.mock.calls[1]!];
    expect(freela[0]).toBe(2);
    expect(freela[1].body).toBe(
      'Até qua, 07/10 às 09:03: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era 05/10/2026.',
    );
    expect(freela[2]).toEqual({ passCategory: 'deadline' });
    expect(cliente[0]).toBe(1);
    expect(cliente[1].body).toBe(
      'Sem entrega nem extensão aceita até qua, 07/10 às 10:03, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era 05/10/2026 e não houve entrega.',
    );
    expect(cliente[2]).toEqual({});

    notify.mockClear();
    expect(await contractsService.notifyOverdue(r, 24, at)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('por marcos: lista o que falta e a cópia do cliente diz quantos foram entregues', async () => {
    repo.markOverdueNotified.mockResolvedValue(true);
    vi.mocked(milestonesRepository.titlesByDelivery).mockResolvedValue({
      delivered: ['Layout'],
      missing: ['Publicação'],
    });
    await contractsService.notifyOverdue(
      row({
        deadline_at: brt('2026-10-05 23:59:59'),
        has_milestones: 1,
        total_milestones: 2,
        undelivered_milestones: 1,
      }),
      24,
      NOW,
    );
    expect(notify.mock.calls[0]![1].body).toContain(
      'entregue o marco «Publicação» ou peça a extensão',
    );
    expect(notify.mock.calls[0]![2]).toEqual({ passCategory: 'deadline' });
    expect(notify.mock.calls[1]![1].body).toContain(
      '1 de 2 marcos entregues; falta o marco «Publicação»',
    );
  });

  it('abre a disputa com a guarda e avisa os dois; sem transição, não avisa', async () => {
    const r = row({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:03:00'),
      grace_ends_at: brt('2026-10-04 09:03:00'),
    });
    disputes.create.mockResolvedValueOnce(77).mockResolvedValueOnce(null);

    expect(await contractsService.openOverdueDispute(r, NOW)).toBe(77);
    expect(disputes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: 1,
        openedBy: 1,
        reason: 'deadline',
        description:
          'Aberta automaticamente pela plataforma (RN-029): o prazo de entrega (02/10/2026) venceu sem entrega, o aviso saiu em 03/10/2026 às 09:03 e, até 04/10/2026 às 09:03, não houve entrega nem extensão aceita. Horários de Brasília.',
      }),
      { guard: 'AND guarda_da_disputa', now: NOW },
    );
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'dispute_opened', data: { contractId: 1, disputeId: 77 } }),
      {},
    );

    expect(await contractsService.openOverdueDispute(r, NOW)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('aceite com o prazo ou a validade vencidos (ADR 57)', () => {
  it('prazo de entrega passado: 409 deadline_passed', async () => {
    repo.findById.mockResolvedValue(
      row({ status: 'pending', deadline_at: brt('2026-10-06 11:00:00') }),
    );
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({ code: 'deadline_passed' });
  });

  it('validade vencida: 409 proposal_expired; a guarda repete as duas condições', async () => {
    repo.findById.mockResolvedValue(
      row({ status: 'pending', proposal_expires_at: brt('2026-10-06 11:59:59') }),
    );
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({ code: 'proposal_expired' });

    repo.findById.mockResolvedValue(
      row({ status: 'pending', proposal_expires_at: brt('2026-10-07 11:59:59') }),
    );
    repo.transition.mockResolvedValue(true);
    await contractsService.accept(1, 2);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        now: NOW,
        guard: { sql: expect.stringContaining('c.proposal_expires_at > :now') },
      }),
    );
  });
});

describe('create: validade da proposta gravada (RN-021, ADR 57)', () => {
  const body = (deadlineAt: string | null) => ({
    freelancerId: 2,
    title: 'Vídeo',
    description: 'Roteiro e edição do vídeo',
    price: 100,
    paymentMode: 'cash' as const,
    deadlineAt,
  });

  it('72 h, mas nunca depois do último instante de dia antes do prazo', async () => {
    settings.mockResolvedValue(72);
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(row({ status: 'pending' }));
    await contractsService.create(1, body(brt('2026-10-07 23:59:59').toISOString()));
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ proposalExpiresAt: brt('2026-10-07 20:29:59') }),
    );
    await contractsService.create(1, body(brt('2026-10-20 23:59:59').toISOString()));
    expect(repo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ proposalExpiresAt: brt('2026-10-09 12:00:00') }),
    );
    expect(notify).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({
        type: 'contract_proposal',
        body: 'Vídeo institucional. Prazo de entrega: 20/10/2026. Responda até sex, 09/10 às 12:00.',
      }),
      {},
    );
  });

  it('prazo perto demais para o freelancer responder: 400 deadline_too_soon', async () => {
    await expect(
      contractsService.create(1, body(brt('2026-10-06 12:30:00').toISOString())),
    ).rejects.toMatchObject({ code: 'deadline_too_soon' });
    expect(repo.create).not.toHaveBeenCalled();
  });
});
