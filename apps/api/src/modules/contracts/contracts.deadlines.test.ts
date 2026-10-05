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
    deliver: vi.fn(),
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
    markOverdueNotified: vi.fn(),
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
// O create confere quem é contratado e o serviço da proposta antes de gravar (ADR 60).
vi.mock('../auth/auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('../services/services.repository', () => ({
  servicesRepository: { findById: vi.fn() },
}));

import { setClockForTests } from '../../utils/clock';
import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { milestonesRepository } from './milestones.repository';
import { authRepository, type UserRow } from '../auth/auth.repository';
import { servicesRepository, type ServiceRow } from '../services/services.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { gamificationService } from '../gamification/gamification.service';
import { notificationsService } from '../notifications/notifications.service';
import { settingsRepository } from '../settings/settings.repository';
import { settingsService } from '../settings/settings.service';
import { userZone } from '../auth/user-zone';
import { walletService } from '../wallet/wallet.service';

const repo = vi.mocked(contractsRepository);
const disputes = vi.mocked(disputesRepository);
const notify = vi.mocked(notificationsService.notify);
const settings = vi.mocked(settingsRepository.getNumber);
const users = vi.mocked(authRepository);
const services = vi.mocked(servicesRepository);

/** A conta de quem é contratado, como o authRepository.findById devolve: ativa, não excluída. */
const freelancerAccount = (id: number): UserRow =>
  ({
    id,
    ulid: `01FREELANCER${String(id).padStart(14, '0')}`,
    email: `freela${id}@escambo.test`,
    password_hash: '$2a$12$hashdasenhadofreelancer',
    role: 'freelancer',
    status: 'active',
    deleted_at: null,
    email_verified_at: new Date('2026-09-01T12:00:00Z'),
    timezone: 'America/Sao_Paulo',
  }) as UserRow;

/** Serviço 5, do freelancer 44, no ar (o da proposta de "o que é gravado"). */
const SERVICE_5 = {
  id: 5,
  user_id: 44,
  category_id: 2,
  title: 'Vídeo institucional',
  description: 'Roteiro, captação e edição de vídeo de até 3 minutos',
  price_type: 'fixed',
  price: '900.00',
  delivery_days: 10,
  is_remote: 1,
  is_active: 1,
  views_count: 40,
  created_at: new Date('2026-09-15T12:00:00Z'),
  deleted_at: null,
} as ServiceRow;

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
  users.findById.mockImplementation(async (id: number) => freelancerAccount(id));
  services.findById.mockResolvedValue(SERVICE_5);
});
afterEach(() => setClockForTests(null));

describe('requestExtension (RN-028, ADR 57)', () => {
  const codeOf = async (r: ContractRow, uid = 2, input = ask()) => {
    repo.findById.mockResolvedValue(r);
    return contractsService.requestExtension(1, uid, input).then(
      () => 'ok',
      (e: { code?: string; statusCode?: number }) => `${e.statusCode} ${e.code}`,
    );
  };

  it('cada regra tem o seu status e o seu código', async () => {
    expect(await codeOf(row(), 1)).toBe('403 forbidden');
    expect(await codeOf(row({ deadline_at: null }))).toBe('409 no_deadline');
    expect(await codeOf(row({ status: 'delivered' }))).toBe('409 extension_after_delivery');
    expect(await codeOf(row({ status: 'revision_requested' }))).toBe(
      '409 extension_after_delivery',
    );
    expect(
      await codeOf(row({ has_milestones: 1, total_milestones: 2, undelivered_milestones: 0 })),
    ).toBe('409 extension_after_delivery');
    expect(await codeOf(row({ deadline_extended_at: NOW }))).toBe('409 extension_used');
    expect(
      await codeOf(
        row({ extension_status: 'pending', extension_deadline_at: brt('2026-10-12 23:59:59') }),
      ),
    ).toBe('409 extension_pending');
    expect(await codeOf(row({ extension_status: 'declined', extension_requests: 2 }))).toBe(
      '409 extension_limit',
    );
    expect(await codeOf(row({ grace_ends_at: brt('2026-10-06 11:00:00') }))).toBe('409 grace_over');
    expect(await codeOf(row(), 2, ask(brt('2026-10-08 23:59:59')))).toBe('400 invalid_deadline');
    // prazo já vencido: pedir uma data que o cliente não consegue decidir a tempo
    expect(
      await codeOf(
        row({ deadline_at: brt('2026-10-05 23:59:59') }),
        2,
        ask(brt('2026-10-06 20:00:00')),
      ),
    ).toBe('400 extension_too_close');
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
    // O novo prazo é dito como dia (ADR 58); o cliente está no mesmo relógio, então sem nota de fuso.
    expect(notify).toHaveBeenCalledWith(
      1,
      {
        type: 'deadline_extension_requested',
        title: 'Pedido de extensão: Vídeo institucional',
        body: 'Responda até qui, 08/10 às 12:00: novo prazo proposto sex, 16/10/2026, até 23:59. Sem resposta, o pedido expira e vale o prazo atual. Motivo: O material do cliente chegou depois do combinado',
        data: { contractId: 1 },
      },
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
      code: 'forbidden',
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

  it('pedido que o job já expirou: 409 extension_expired dizendo até quando dava para responder', async () => {
    repo.findById.mockResolvedValue(
      pending({ extension_status: 'expired', extension_respond_by: brt('2026-10-06 10:00:00') }),
    );
    for (const accept of [true, false]) {
      await expect(contractsService.resolveExtension(1, 1, accept, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: 'extension_expired',
        message: 'O prazo para responder a este pedido acabou ter, 06/10 às 10:00; ele expirou.',
      });
    }
    expect(repo.acceptExtension).not.toHaveBeenCalled();
    expect(repo.settleExtension).not.toHaveBeenCalled();
  });

  it('corrida na decisão (o job expirou o pedido no meio): 409 conflict e quem entrega não é avisado', async () => {
    repo.findById.mockResolvedValue(pending());
    repo.acceptExtension.mockResolvedValue(false);
    repo.settleExtension.mockResolvedValue(false);
    await expect(contractsService.resolveExtension(1, 1, true, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    await expect(contractsService.resolveExtension(1, 1, false, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(notify).not.toHaveBeenCalled();
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
        // O histórico não tem leitor: o novo prazo sempre leva o fuso (ADR 58).
        note: 'Prazo estendido de sex, 09/10 para sex, 16/10/2026, até 23:59 (horário de Brasília) (RN-028): Atraso do material',
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      2,
      {
        type: 'deadline_extension_accepted',
        title: 'Extensão aceita: novo prazo sex, 16/10',
        body: 'Vídeo institucional: o novo prazo é sex, 16/10/2026, até 23:59; não há outra extensão nesta contratação.',
        data: { contractId: 1 },
      },
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
      body: 'Prazo vencido. Até qua, 07/10 às 09:00: entregue ou peça a extensão, senão a disputa abre sozinha. O prazo era sex, 02/10/2026, até 23:59. Você ainda pode fazer mais um pedido.',
    });
    expect(opts).toEqual({});
  });

  it('recusar depois do prazo com o aviso de atraso ainda por sair: não há carência para devolver, e o aviso diz quando o atraso será cobrado', async () => {
    // O pedido pendente segurava a fase 1 do job: o prazo venceu ontem e ninguém foi avisado.
    const r = pending({
      deadline_at: brt('2026-10-05 23:59:59'),
      extension_requested_at: brt('2026-10-05 10:00:00'),
      extension_respond_by: brt('2026-10-07 10:00:00'),
    });
    repo.findById.mockResolvedValueOnce(r).mockResolvedValue({
      ...r,
      extension_status: 'declined',
      extension_resolved_at: NOW,
    } as ContractRow);
    repo.settleExtension.mockResolvedValue(true);

    const c = await contractsService.resolveExtension(1, 1, false, 1);

    expect(repo.settleExtension).toHaveBeenCalledWith({
      id: 1,
      seq: 1,
      outcome: 'declined',
      now: NOW,
      graceEndsAt: null,
    });
    // O aviso de atraso só sai depois da decisão (12:00), e a carência de 24 h conta dele.
    expect(notify).toHaveBeenCalledWith(
      2,
      {
        type: 'deadline_extension_declined',
        title: 'Extensão recusada: Vídeo institucional',
        body: 'Sem entrega nem extensão aceita, a disputa abre a partir de qua, 07/10 às 12:00; o aviso de atraso sai a partir de ter, 06/10 às 12:00. O prazo era seg, 05/10/2026, até 23:59. Você ainda pode fazer mais um pedido.',
        data: { contractId: 1 },
      },
      {},
    );
    expect(c.extension).toMatchObject({ status: 'declined', seq: 1 });
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
      {
        type: 'deadline_extension_expired',
        title: 'Pedido de extensão sem resposta: Vídeo institucional',
        body: 'Vale o prazo atual, sex, 09/10/2026, até 23:59. O cliente não respondeu até ter, 06/10 às 10:00. Você ainda pode fazer mais um pedido.',
        data: { contractId: 1 },
      },
      {},
    );
    expect(notify).toHaveBeenCalledWith(
      1,
      {
        type: 'deadline_extension_expired',
        title: 'Pedido de extensão expirou: Vídeo institucional',
        body: 'Sem a sua resposta até ter, 06/10 às 10:00, o pedido de novo prazo, sex, 16/10/2026, até 23:59, expirou e vale o prazo atual, sex, 09/10/2026, até 23:59.',
        data: { contractId: 1 },
      },
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
        guard: { sql: 'AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now' },
        note: 'Proposta expirada: sem resposta do freelancer até 06/10/2026 às 11:00 (horário de Brasília, RN-021)',
        milestonesTo: { from: ['pending', 'funded', 'delivered'], to: 'cancelled' },
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
    // O prazo é 23:59:59 em Brasília (não em Manaus): quem entrega lê o dia com o fuso anotado, e
    // o cliente, no mesmo relógio do prazo, sem a nota (ADR 58).
    expect(freela[1].body).toBe(
      'Até qua, 07/10 às 09:03: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era seg, 05/10/2026, até 23:59 (horário de Brasília).',
    );
    expect(freela[2]).toEqual({ passCategory: 'deadline' });
    expect(cliente[0]).toBe(1);
    expect(cliente[1].body).toBe(
      'Sem entrega nem extensão aceita até qua, 07/10 às 10:03, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era seg, 05/10/2026, até 23:59 e não houve entrega.',
    );
    expect(cliente[2]).toEqual({});

    notify.mockClear();
    expect(await contractsService.notifyOverdue(r, 24, at)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('por marcos: lista o que falta e a cópia do cliente diz quantos foram entregues', async () => {
    repo.markOverdueNotified.mockResolvedValue(true);
    vi.mocked(milestonesRepository.titlesByDelivery).mockResolvedValueOnce({
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
    expect(milestonesRepository.titlesByDelivery).toHaveBeenCalledWith(1);
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
          'Aberta automaticamente pela plataforma (RN-029): o prazo de entrega, sex, 02/10/2026, até 23:59 (horário de Brasília), venceu sem entrega, o aviso saiu em 03/10/2026 às 09:03 e, até 04/10/2026 às 09:03, não houve entrega nem extensão aceita. O aviso e o limite estão em horário de Brasília.',
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

  it('por marcos, com marco já entregue: a disputa lista o que foi e o que não foi entregue e nunca diz "sem entrega"', async () => {
    const r = row({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:03:00'),
      grace_ends_at: brt('2026-10-04 09:03:00'),
      has_milestones: 1,
      total_milestones: 2,
      undelivered_milestones: 1,
      client_timezone: 'America/Manaus',
    });
    vi.mocked(milestonesRepository.titlesByDelivery).mockResolvedValueOnce({
      delivered: ['Layout'],
      missing: ['Publicação'],
    });
    disputes.create.mockResolvedValueOnce(78);

    expect(await contractsService.openOverdueDispute(r, NOW)).toBe(78);

    expect(disputes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          'Aberta automaticamente pela plataforma (RN-029): o prazo de entrega, sex, 02/10/2026, até 23:59 (horário de Brasília), venceu com marcos nunca entregues, o aviso saiu em 03/10/2026 às 09:03 e, até 04/10/2026 às 09:03, eles não foram entregues nem houve extensão aceita. O aviso e o limite estão em horário de Brasília. Marcos entregues: «Layout»; sem entrega: «Publicação».',
      }),
      { guard: 'AND guarda_da_disputa', now: NOW },
    );
    // Cada parte lê a hora-limite no próprio fuso (o cliente está em Manaus, uma hora a menos).
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        body: 'Vídeo institucional: sem os marcos que faltavam nem extensão aceita até dom, 04/10 às 08:03, a disputa abriu e a mediação do Escambo decide sobre o valor.',
      }),
      {},
    );
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        body: 'Vídeo institucional: sem os marcos que faltavam nem extensão aceita até dom, 04/10 às 09:03, a disputa abriu e a mediação do Escambo decide sobre o valor.',
      }),
      {},
    );
  });

  it('contratação sem prazo nunca recebe aviso de atraso', async () => {
    expect(await contractsService.notifyOverdue(row({ deadline_at: null }), 24, NOW)).toBe(false);
    expect(repo.markOverdueNotified).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('entrega única (RN-024, ADR 57)', () => {
  // Terça, 21:00 em Brasília: 5 dias depois cai no domingo às 21:00, fora da hora de dia.
  const AT = brt('2026-10-06 21:00:00');

  it('grava a hora da aprovação tácita levada para as 9h se cairia de noite no fuso do cliente, e o avisa até quando responder', async () => {
    setClockForTests(AT, { frozen: true });
    settings.mockResolvedValue(5);
    repo.findById
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: 'delivered', deliveries_count: 1 }));
    repo.deliver.mockResolvedValue(true);

    const c = await contractsService.deliver(1, 2, { message: 'Pronto para revisar' });

    // O número de dias vem do painel (tacit_approval_days), com 5 de padrão.
    expect(settings).toHaveBeenCalledWith('tacit_approval_days', 5);
    expect(repo.deliver).toHaveBeenCalledWith({
      id: 1,
      changedBy: 2,
      from: 'accepted',
      message: 'Pronto para revisar',
      files: null,
      now: AT,
      approvalDueAt: brt('2026-10-12 09:00:00'),
    });
    expect(notify).toHaveBeenCalledWith(
      1,
      {
        type: 'contract_delivered',
        title: 'Entrega registrada: Vídeo institucional',
        body: 'Aprove, peça revisão ou abra disputa até seg, 12/10 às 09:00. Depois disso, a entrega é aprovada automaticamente.',
        data: { contractId: 1 },
      },
      {},
    );
    expect(c.status).toBe('delivered');
  });

  it('o fuso que vale é o do cliente: em Manaus as mesmas 21:00 de Brasília ainda são 20:00, de dia', async () => {
    setClockForTests(AT, { frozen: true });
    settings.mockResolvedValue(5);
    repo.findById.mockResolvedValue(row({ client_timezone: 'America/Manaus' }));
    repo.deliver.mockResolvedValue(true);
    const files = ['https://cdn.escambo.test/entrega.zip'];

    await contractsService.deliver(1, 2, { message: 'Pronto', files });

    expect(repo.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ files, approvalDueAt: brt('2026-10-11 21:00:00') }),
    );
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        body: expect.stringContaining('até dom, 11/10 às 20:00.'),
      }),
      {},
    );
  });

  it('corrida (a contratação saiu do status lido): 409 conflict e o cliente não é avisado', async () => {
    repo.findById.mockResolvedValue(row());
    repo.deliver.mockResolvedValue(false);
    await expect(contractsService.deliver(1, 2, { message: 'Pronto' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a revisão pode ser entregue de novo; contratação ainda em proposta, não', async () => {
    repo.deliver.mockResolvedValue(true);
    repo.findById.mockResolvedValue(row({ status: 'revision_requested', deliveries_count: 1 }));
    await contractsService.deliver(1, 2, { message: 'Corrigido' });
    expect(repo.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'revision_requested', message: 'Corrigido' }),
    );

    repo.deliver.mockClear();
    repo.findById.mockResolvedValue(row({ status: 'pending' }));
    await expect(contractsService.deliver(1, 2, { message: 'Pronto' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(repo.deliver).not.toHaveBeenCalled();
  });
});

describe('marco atrasado (RN-069, ADR 57)', () => {
  // Prazo do marco: o fim de 05/10 em Manaus (23:59:59), que já é 00:59:59 de 06/10 em Brasília.
  const overdue = {
    id: 5,
    contract_id: 31,
    title: 'Layout',
    due_at: brt('2026-10-06 00:59:59'),
    client_id: 7,
    freelancer_id: 44,
    contract_title: 'Vídeo institucional',
    freelancer_timezone: 'America/Manaus',
    client_timezone: 'America/Sao_Paulo',
  } as never;
  const mark = vi.mocked(milestonesRepository.markOverdueNotified);

  it('não avisa antes das 9h no fuso de quem entrega, mesmo que o job rode', async () => {
    // 09:30 em Brasília ainda são 08:30 em Manaus.
    expect(await contractsService.notifyMilestoneOverdue(overdue, brt('2026-10-06 09:30:00'))).toBe(
      false,
    );
    expect(mark).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('marca o aviso uma vez e avisa as duas partes com o mesmo dia, com o fuso anotado só para quem está em outro relógio, sem furar o silêncio', async () => {
    mark.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const at = brt('2026-10-06 10:03:00.400'); // 09:03 em Manaus

    expect(await contractsService.notifyMilestoneOverdue(overdue, at)).toBe(true);

    // O instante gravado vai sem a fração de segundo (o DATETIME do MySQL arredonda).
    expect(mark).toHaveBeenCalledWith(5, brt('2026-10-06 10:03:00'));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'milestone_overdue',
        title: 'Marco atrasado: Layout',
        body: 'Vídeo institucional: o prazo deste marco era seg, 05/10/2026, até 23:59. Entregue o marco ou combine com o cliente pelo chat.',
        data: { contractId: 31, milestoneId: 5 },
      },
      {},
    );
    // O cliente, em Brasília, lê o mesmo dia 05/10 (não 06/10), com o fuso do prazo anotado.
    expect(notify).toHaveBeenCalledWith(
      7,
      {
        type: 'milestone_overdue',
        title: 'Marco atrasado: Layout',
        body: 'Vídeo institucional: o prazo deste marco era seg, 05/10/2026, até 23:59 (horário de Manaus) e ele não foi entregue. É o prazo da contratação que abre a disputa automática.',
        data: { contractId: 31, milestoneId: 5 },
      },
      {},
    );

    // Outra instância do job já marcou (ou o marco foi entregue no meio): ninguém é avisado de novo.
    notify.mockClear();
    expect(await contractsService.notifyMilestoneOverdue(overdue, at)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('prazo antigo que não é fim de dia em nenhum fuso: vale o fuso de quem entrega, com a hora real', async () => {
    mark.mockResolvedValueOnce(true);
    // 23:30 em Manaus (00:30 em Brasília): nenhum relógio marca 23:59:59.
    const old = { ...(overdue as object), due_at: brt('2026-10-06 00:30:00') } as never;

    expect(await contractsService.notifyMilestoneOverdue(old, brt('2026-10-06 10:03:00'))).toBe(
      true,
    );

    expect(notify.mock.calls.map((c) => [c[0], c[1].body])).toEqual([
      [
        44,
        'Vídeo institucional: o prazo deste marco era seg, 05/10/2026, até 23:30. Entregue o marco ou combine com o cliente pelo chat.',
      ],
      [
        7,
        'Vídeo institucional: o prazo deste marco era seg, 05/10/2026, até 23:30 (horário de Manaus) e ele não foi entregue. É o prazo da contratação que abre a disputa automática.',
      ],
    ]);
  });
});

describe('aprovação tácita da entrega única (RN-024, job)', () => {
  const delivered = () =>
    row({
      status: 'delivered',
      deliveries_count: 1,
      approval_due_at: brt('2026-10-06 11:00:00'),
    });

  it('aprova em nome do cliente e libera o escrow, com a guarda repetindo a hora gravada na entrega', async () => {
    repo.findById
      .mockResolvedValueOnce(delivered())
      .mockResolvedValueOnce(row({ status: 'completed', deliveries_count: 1 }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.approveTacitly(1, NOW);

    expect(repo.transition).toHaveBeenCalledWith({
      id: 1,
      changedBy: 1,
      from: 'delivered',
      to: 'completed',
      note: 'Aprovação tácita: sem resposta do cliente até 06/10/2026 às 11:00 (horário de Brasília, RN-024)',
      timestampColumn: 'completed_at',
      now: NOW,
      // Uma revisão seguida de nova entrega no meio grava outra hora: a guarda não deixa passar.
      guard: { sql: 'AND c.approval_due_at IS NOT NULL AND c.approval_due_at <= :now' },
      walletEffects: [
        { userId: 2, pendingDelta: -765, balanceDelta: 765, reason: 'escrow_release' },
      ],
    });
    expect(c.status).toBe('completed');
    // A tácita move dinheiro sozinha: as duas partes são avisadas (ADR 58). O cliente lê o valor da
    // contratação e até quando avalia (7 dias depois de agora); quem entrega, o líquido.
    expect(notify.mock.calls).toEqual([
      [
        1,
        {
          type: 'contract_auto_approved',
          title: 'Aprovada automaticamente: Vídeo institucional',
          body: 'Sem resposta até ter, 06/10 às 11:00, a entrega foi aprovada e o pagamento foi liberado ao freelancer (contratação de R$ 900,00). Você pode avaliar até ter, 13/10 às 12:00.',
          data: { contractId: 1 },
        },
        {},
      ],
      [
        2,
        {
          type: 'contract_completed',
          title: 'Contratação concluída: Vídeo institucional',
          body: 'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e R$ 765,00 foi liberado na sua carteira.',
          data: { contractId: 1 },
        },
        {},
      ],
    ]);
    // Os avisos só saem depois da transição gravada.
    expect(repo.transition.mock.invocationCallOrder[0]!).toBeLessThan(
      notify.mock.invocationCallOrder[0]!,
    );
  });

  it('cada parte lê a hora da aprovação no próprio fuso, e o cliente lê no dele até quando avalia', async () => {
    repo.findById.mockResolvedValue({
      ...delivered(),
      client_timezone: 'America/Manaus',
    } as ContractRow);
    repo.transition.mockResolvedValue(true);

    await contractsService.approveTacitly(1, NOW);

    expect(notify.mock.calls.map((c) => [c[0], c[1].body])).toEqual([
      [
        1,
        'Sem resposta até ter, 06/10 às 10:00, a entrega foi aprovada e o pagamento foi liberado ao freelancer (contratação de R$ 900,00). Você pode avaliar até ter, 13/10 às 11:00.',
      ],
      [
        2,
        'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e R$ 765,00 foi liberado na sua carteira.',
      ],
    ]);
  });

  it('em créditos, os avisos dizem os créditos liberados; na troca, que a entrega conta para fechar a troca', async () => {
    repo.transition.mockResolvedValue(true);
    repo.findById.mockResolvedValue({ ...delivered(), payment_mode: 'credits' } as ContractRow);

    await contractsService.approveTacitly(1, NOW);

    expect(notify.mock.calls.map((c) => [c[0], c[1].body])).toEqual([
      [
        1,
        'Sem resposta até ter, 06/10 às 11:00, a entrega foi aprovada e os 765 créditos foram liberados ao freelancer. Você pode avaliar até ter, 13/10 às 12:00.',
      ],
      [
        2,
        'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e 765 créditos foram liberados na sua carteira.',
      ],
    ]);

    notify.mockClear();
    repo.findById.mockResolvedValue({ ...delivered(), payment_mode: 'barter' } as ContractRow);

    await contractsService.approveTacitly(1, NOW);

    expect(notify.mock.calls.map((c) => [c[0], c[1].body])).toEqual([
      [
        1,
        'Sem resposta até ter, 06/10 às 11:00, a entrega foi aprovada e conta para fechar a troca. Você pode avaliar até ter, 13/10 às 12:00.',
      ],
      [
        2,
        'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e conta para fechar a troca.',
      ],
    ]);
  });

  it('entrega que o cliente já respondeu (saiu de delivered) não é aprovada nem avisada', async () => {
    repo.findById.mockResolvedValue(row({ status: 'revision_requested', deliveries_count: 1 }));
    await expect(contractsService.approveTacitly(1, NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('se a hora gravada mudou no meio (a guarda não pegou): 409 conflict e ninguém é avisado', async () => {
    repo.findById.mockResolvedValue(delivered());
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.approveTacitly(1, NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(notify).not.toHaveBeenCalled();
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();
  });
});

describe('aceite com o prazo ou a validade vencidos (ADR 57)', () => {
  it('prazo de entrega passado: 409 deadline_passed', async () => {
    repo.findById.mockResolvedValue(
      row({ status: 'pending', deadline_at: brt('2026-10-06 11:00:00') }),
    );
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deadline_passed',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('validade vencida: 409 proposal_expired; a guarda repete as duas condições', async () => {
    repo.findById.mockResolvedValue(
      row({ status: 'pending', proposal_expires_at: brt('2026-10-06 11:59:59') }),
    );
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'proposal_expired',
    });
    expect(repo.transition).not.toHaveBeenCalled();

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
      {
        type: 'contract_proposal',
        title: 'Nova proposta de contratação',
        body: 'Vídeo institucional. Prazo de entrega: ter, 20/10/2026, até 23:59. Responda até sex, 09/10 às 12:00.',
        data: { contractId: 1 },
      },
      {},
    );
  });

  it('prazo perto demais para o freelancer responder: 400 deadline_too_soon', async () => {
    await expect(
      contractsService.create(1, body(brt('2026-10-06 12:30:00').toISOString())),
    ).rejects.toMatchObject({ statusCode: 400, code: 'deadline_too_soon' });
    expect(repo.create).not.toHaveBeenCalled();
  });
});

/**
 * Ids que não se repetem (contratação 31, cliente 7, freelancer 44): nos exemplos acima a
 * contratação e o cliente têm o mesmo número, e uma troca entre os dois passaria despercebida.
 */
const other = (o: Partial<Omit<ContractRow, 'constructor'>> = {}): ContractRow =>
  row({ id: 31, client_id: 7, freelancer_id: 44, ...o });

const CANCEL_MILESTONES = { from: ['pending', 'funded', 'delivered'], to: 'cancelled' };
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('requestExtension: limites e fusos (RN-028, ADR 57)', () => {
  const attempt = async (r: ContractRow, input = ask()) => {
    repo.findById.mockResolvedValue(r);
    repo.requestExtension.mockResolvedValue(true);
    return contractsService.requestExtension(1, 2, input).then(
      () => 'ok',
      (e: { code?: string; statusCode?: number }) => `${e.statusCode} ${e.code}`,
    );
  };

  it('antes do aceite ou depois de encerrada não há prazo correndo para estender: 409 invalid_transition', async () => {
    for (const status of ['pending', 'completed', 'cancelled', 'rejected', 'disputed']) {
      expect(await attempt(row({ status })), status).toBe('409 invalid_transition');
    }
    expect(repo.requestExtension).not.toHaveBeenCalled();
  });

  it('a carência acaba no instante gravado: nele já não cabe pedido; um segundo antes, cabe', async () => {
    expect(await attempt(row({ grace_ends_at: NOW }))).toBe('409 grace_over');
    expect(repo.requestExtension).not.toHaveBeenCalled();
    expect(await attempt(row({ grace_ends_at: new Date(NOW.getTime() + 1000) }))).toBe('ok');
  });

  it('o novo prazo precisa passar do prazo atual e do agora: igual a um dos dois não vale', async () => {
    // Igual ao prazo atual.
    expect(await attempt(row(), ask(brt('2026-10-09 23:59:59')))).toBe('400 invalid_deadline');
    // Prazo já vencido: a data pedida passa do prazo, mas não do agora.
    const late = row({ deadline_at: brt('2026-10-05 23:59:59') });
    expect(await attempt(late, ask(brt('2026-10-06 11:00:00')))).toBe('400 invalid_deadline');
    expect(await attempt(late, ask(NOW))).toBe('400 invalid_deadline');
    expect(repo.requestExtension).not.toHaveBeenCalled();
    // Um segundo depois do prazo atual já é um prazo novo.
    expect(await attempt(row(), ask(brt('2026-10-10 00:00:00')))).toBe('ok');
  });

  it('data perto demais: o erro diz a partir de que dia dá para pedir', async () => {
    repo.findById.mockResolvedValue(row({ deadline_at: brt('2026-10-05 23:59:59') }));
    await expect(
      contractsService.requestExtension(1, 2, ask(brt('2026-10-06 20:00:00'))),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'extension_too_close',
      message:
        'O novo prazo está perto demais para o cliente decidir a tempo: escolha uma data a partir de 08/10/2026.',
    });
  });

  it('a hora de resposta é contada e dita no fuso do cliente, e o prazo pedido é gravado sem a fração de segundo', async () => {
    // 20:45 em Brasília já é noite (iria para as 9h seguintes); em Manaus ainda são 19:45, de dia.
    const at = brt('2026-10-06 20:45:00');
    setClockForTests(at, { frozen: true });
    repo.findById.mockResolvedValue(other({ client_timezone: 'America/Manaus' }));
    repo.requestExtension.mockResolvedValue(true);
    const input = {
      // O fim de 16/10 em Manaus (00:59:59 de 17/10 em Brasília), com a fração que a tela pode mandar.
      deadlineAt: '2026-10-17T03:59:59.500Z',
      reason: 'O material do cliente chegou depois do combinado',
    };

    await contractsService.requestExtension(31, 44, input);

    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(repo.requestExtension).toHaveBeenCalledWith({
      id: 31,
      deadlineAt: new Date('2026-10-17T03:59:59.000Z'),
      reason: input.reason,
      now: at,
      respondBy: brt('2026-10-08 20:45:00'),
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      7,
      {
        type: 'deadline_extension_requested',
        title: 'Pedido de extensão: Vídeo institucional',
        // O dia pedido é o de Manaus, o mesmo relógio do cliente: sem nota de fuso.
        body: 'Responda até qui, 08/10 às 19:45: novo prazo proposto sex, 16/10/2026, até 23:59. Sem resposta, o pedido expira e vale o prazo atual. Motivo: O material do cliente chegou depois do combinado',
        data: { contractId: 31 },
      },
      {},
    );
  });
});

describe('resolveExtension: quem decide, quem é avisado e em que fuso (RN-028, ADR 57)', () => {
  const pending = (o: Partial<Omit<ContractRow, 'constructor'>> = {}) =>
    other({
      status: 'in_progress',
      extension_status: 'pending',
      extension_requests: 1,
      // O fim de 16/10 em Manaus, o fuso de quem entrega.
      extension_deadline_at: brt('2026-10-17 00:59:59'),
      extension_reason: 'Atraso do material',
      extension_requested_at: brt('2026-10-06 10:00:00'),
      extension_respond_by: brt('2026-10-08 10:00:00'),
      freelancer_timezone: 'America/Manaus',
      ...o,
    });

  it('a hora de responder e a data pedida valem até o instante exato: nele, já passou', async () => {
    repo.findById.mockResolvedValue(pending({ extension_respond_by: NOW }));
    for (const accept of [true, false]) {
      await expect(contractsService.resolveExtension(31, 7, accept, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: 'extension_expired',
        message: 'O prazo para responder a este pedido acabou ter, 06/10 às 12:00; ele expirou.',
      });
    }
    repo.findById.mockResolvedValue(pending({ extension_deadline_at: NOW }));
    await expect(contractsService.resolveExtension(31, 7, true, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'extension_stale',
    });
    expect(repo.acceptExtension).not.toHaveBeenCalled();
    expect(repo.settleExtension).not.toHaveBeenCalled();
  });

  it('quem entrega não decide o próprio pedido: 403 forbidden', async () => {
    repo.findById.mockResolvedValue(pending());
    for (const accept of [true, false]) {
      await expect(contractsService.resolveExtension(31, 44, accept, 1)).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
        message: 'Ação exclusiva do cliente',
      });
    }
    expect(repo.acceptExtension).not.toHaveBeenCalled();
    expect(repo.settleExtension).not.toHaveBeenCalled();
  });

  it('aceitar sem o número do pedido vale para o pedido pendente; a linha do tempo diz de quando para quando e o aviso vai a quem entrega, no fuso dele', async () => {
    repo.findById.mockResolvedValue(pending());
    repo.acceptExtension.mockResolvedValue(true);

    const c = await contractsService.resolveExtension(31, 7, true);

    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(repo.acceptExtension).toHaveBeenCalledWith({
      id: 31,
      seq: null,
      now: NOW,
      changedBy: 7,
      // O status não muda: a linha do tempo repete o atual.
      status: 'in_progress',
      // O histórico não tem leitor: cada prazo é dito no fuso em que é um dia, com a nota do fuso.
      note: 'Prazo estendido de sex, 09/10 para sex, 16/10/2026, até 23:59 (horário de Manaus) (RN-028): Atraso do material',
    });
    expect(repo.settleExtension).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    // Quem entrega está em Manaus, o relógio do novo prazo: o dia vai sem nota de fuso.
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'deadline_extension_accepted',
        title: 'Extensão aceita: novo prazo sex, 16/10',
        body: 'Vídeo institucional: o novo prazo é sex, 16/10/2026, até 23:59; não há outra extensão nesta contratação.',
        data: { contractId: 31 },
      },
      {},
    );
    expect(c.id).toBe(31);
  });

  it('recusar devolve a carência contada no fuso de quem entrega, com a carência vigente do painel, e o aviso lista o marco que falta', async () => {
    const r = pending({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:00:00'),
      grace_ends_at: brt('2026-10-06 18:00:00'),
      has_milestones: 1,
      total_milestones: 2,
      undelivered_milestones: 1,
    });
    repo.findById.mockResolvedValueOnce(r).mockResolvedValueOnce({
      ...r,
      extension_status: 'declined',
      grace_ends_at: brt('2026-10-07 10:00:00'),
    } as ContractRow);
    repo.settleExtension.mockResolvedValue(true);
    vi.mocked(milestonesRepository.titlesByDelivery).mockResolvedValueOnce({
      delivered: ['Layout'],
      missing: ['Publicação'],
    });

    await contractsService.resolveExtension(31, 7, false, 1);

    expect(settings).toHaveBeenCalledWith('deadline_grace_hours', 24);
    // 18:00 + 2 h de pausa = 20:00; as 12 h de relógio levam a 00:00 de Brasília, que são 23:00 em
    // Manaus: noite, então 09:00 de Manaus (10:00 de Brasília). Em Brasília seriam 09:00.
    expect(repo.settleExtension).toHaveBeenCalledWith({
      id: 31,
      seq: 1,
      outcome: 'declined',
      now: NOW,
      graceEndsAt: brt('2026-10-07 10:00:00'),
    });
    expect(repo.acceptExtension).not.toHaveBeenCalled();
    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(milestonesRepository.titlesByDelivery).toHaveBeenCalledWith(31);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'deadline_extension_declined',
        title: 'Extensão recusada: Vídeo institucional',
        // O prazo era o fim do dia em Brasília (o fuso do cliente); quem entrega, em Manaus, lê o fuso.
        body: 'Prazo vencido. Até qua, 07/10 às 09:00: entregue o marco «Publicação» ou peça a extensão, senão a disputa abre sozinha. O prazo era sex, 02/10/2026, até 23:59 (horário de Brasília). Você ainda pode fazer mais um pedido.',
        data: { contractId: 31 },
      },
      {},
    );
  });
});

describe('expireExtension: quem é avisado e com que carência (job, ADR 57)', () => {
  it('cada parte lê a hora no próprio fuso, e o cliente lê o prazo pedido e o que continua valendo', async () => {
    const r = other({
      extension_status: 'pending',
      extension_requests: 1,
      extension_deadline_at: brt('2026-10-16 23:59:59'),
      extension_requested_at: brt('2026-10-04 10:00:00'),
      extension_respond_by: brt('2026-10-06 10:00:00'),
      client_timezone: 'America/Manaus',
    });
    repo.findById.mockResolvedValue({ ...r, extension_status: 'expired' } as ContractRow);
    repo.settleExtension.mockResolvedValue(true);

    expect(await contractsService.expireExtension(r, 24, NOW)).toBe(true);

    expect(repo.settleExtension).toHaveBeenCalledWith({
      id: 31,
      seq: 1,
      outcome: 'expired',
      now: NOW,
      graceEndsAt: null,
    });
    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'deadline_extension_expired',
        title: 'Pedido de extensão sem resposta: Vídeo institucional',
        body: 'Vale o prazo atual, sex, 09/10/2026, até 23:59. O cliente não respondeu até ter, 06/10 às 10:00. Você ainda pode fazer mais um pedido.',
        data: { contractId: 31 },
      },
      {},
    );
    expect(notify).toHaveBeenCalledWith(
      7,
      {
        type: 'deadline_extension_expired',
        title: 'Pedido de extensão expirou: Vídeo institucional',
        // O cliente está em Manaus: os dois prazos são o fim do dia em Brasília e levam a nota.
        body: 'Sem a sua resposta até ter, 06/10 às 09:00, o pedido de novo prazo, sex, 16/10/2026, até 23:59 (horário de Brasília), expirou e vale o prazo atual, sex, 09/10/2026, até 23:59 (horário de Brasília).',
        data: { contractId: 31 },
      },
      {},
    );
  });

  it('com o aviso de atraso já dado, a carência volta de onde parou, contada com as horas que o job passou', async () => {
    // Linha sem o fim da carência gravado: ele sai do aviso mais as horas de carência.
    const r = other({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:00:00'),
      extension_status: 'pending',
      extension_requests: 2,
      extension_deadline_at: brt('2026-10-16 23:59:59'),
      extension_requested_at: brt('2026-10-04 10:00:00'),
      extension_respond_by: brt('2026-10-06 10:00:00'),
    });
    repo.findById.mockResolvedValue({ ...r, extension_status: 'expired' } as ContractRow);
    repo.settleExtension.mockResolvedValue(true);

    await contractsService.expireExtension(r, 48, NOW);
    // 48 h depois do aviso: 05/10 09:00; mais as 50 h de espera pelo cliente: 07/10 11:00.
    expect(repo.settleExtension).toHaveBeenLastCalledWith({
      id: 31,
      seq: 2,
      outcome: 'expired',
      now: NOW,
      graceEndsAt: brt('2026-10-07 11:00:00'),
    });

    await contractsService.expireExtension(r, 24, NOW);
    // Com 24 h a conta daria 06/10 11:00, já passado: vale o piso da decisão (09:00 seguintes).
    expect(repo.settleExtension).toHaveBeenLastCalledWith(
      expect.objectContaining({ graceEndsAt: brt('2026-10-07 09:00:00') }),
    );
  });
});

describe('expireProposal: o que volta e o que cada parte lê (RN-021)', () => {
  const expired = (o: Partial<Omit<ContractRow, 'constructor'>> = {}) =>
    other({
      status: 'pending',
      accepted_at: null,
      proposal_expires_at: brt('2026-10-06 11:00:00'),
      freelancer_timezone: 'America/Manaus',
      ...o,
    });

  it('cancela em nome do cliente, devolve a reserva a ele, cancela os marcos e a guarda repete a hora gravada', async () => {
    repo.findById
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(other({ status: 'cancelled', accepted_at: null }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.expireProposal(31, NOW);

    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(repo.transition).toHaveBeenCalledWith({
      id: 31,
      changedBy: 7,
      from: 'pending',
      to: 'cancelled',
      note: 'Proposta expirada: sem resposta do freelancer até 06/10/2026 às 11:00 (horário de Brasília, RN-021)',
      timestampColumn: 'cancelled_at',
      now: NOW,
      guard: { sql: 'AND c.proposal_expires_at IS NOT NULL AND c.proposal_expires_at <= :now' },
      walletEffects: [{ userId: 7, pendingDelta: -900, balanceDelta: 900, reason: 'refund' }],
      milestonesTo: CANCEL_MILESTONES,
    });
    expect(c).toMatchObject({ id: 31, status: 'cancelled' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      7,
      {
        type: 'contract_expired',
        title: 'Sua proposta expirou sem resposta',
        body: 'Vídeo institucional: o freelancer não respondeu até ter, 06/10 às 11:00. O valor reservado voltou para a sua carteira.',
        data: { contractId: 31 },
      },
      {},
    );
    // Quem não respondeu está em Manaus: lê a hora dele.
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'contract_expired',
        title: 'Uma proposta expirou',
        body: 'Vídeo institucional: sem resposta até ter, 06/10 às 10:00, a proposta foi encerrada.',
        data: { contractId: 31 },
      },
      {},
    );
  });

  it('em créditos nada tinha sido reservado: não move R$ e o aviso não fala em valor devolvido', async () => {
    repo.findById
      .mockResolvedValueOnce(expired({ payment_mode: 'credits' }))
      .mockResolvedValueOnce(other({ status: 'cancelled', payment_mode: 'credits' }));
    repo.transition.mockResolvedValue(true);

    await contractsService.expireProposal(31, NOW);

    expect(repo.transition.mock.calls[0]![0].walletEffects).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        body: 'Vídeo institucional: o freelancer não respondeu até ter, 06/10 às 11:00.',
      }),
      {},
    );
  });

  it('se o freelancer respondeu no meio (a guarda não pegou): 409 conflict e ninguém é avisado', async () => {
    repo.findById.mockResolvedValue(expired());
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.expireProposal(31, NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('entrega única: em que status se entrega (RF-035)', () => {
  it('entrega com a contratação aceita, em andamento ou em revisão, saindo do status lido', async () => {
    repo.deliver.mockResolvedValue(true);
    for (const status of ['accepted', 'in_progress', 'revision_requested']) {
      repo.deliver.mockClear();
      repo.findById.mockResolvedValue(row({ status }));
      await contractsService.deliver(1, 2, { message: 'Pronto' });
      expect(repo.deliver, status).toHaveBeenCalledWith(expect.objectContaining({ from: status }));
    }
  });

  it('antes do aceite, já entregue ou encerrada: 409 e nada é gravado', async () => {
    repo.deliver.mockClear();
    for (const status of ['pending', 'delivered', 'completed', 'cancelled', 'disputed']) {
      repo.findById.mockResolvedValue(row({ status }));
      await expect(
        contractsService.deliver(1, 2, { message: 'Pronto' }),
        status,
      ).rejects.toMatchObject({ statusCode: 409, code: 'invalid_transition' });
    }
    expect(repo.deliver).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('quem age e quem é avisado nos prazos', () => {
  it('a entrega é gravada em nome de quem entrega, e quem é avisado é o cliente', async () => {
    repo.findById.mockResolvedValue(other());
    repo.deliver.mockResolvedValue(true);

    const c = await contractsService.deliver(31, 44, { message: 'Pronto' });

    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(repo.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 31, changedBy: 44, from: 'accepted' }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'contract_delivered', data: { contractId: 31 } }),
      {},
    );
    expect(c.id).toBe(31);
  });

  it('a aprovação tácita fica em nome do cliente, libera o líquido ao freelancer e dá o XP da contratação', async () => {
    repo.findById
      .mockResolvedValueOnce(
        other({
          status: 'delivered',
          deliveries_count: 1,
          approval_due_at: brt('2026-10-06 11:00:00'),
        }),
      )
      .mockResolvedValueOnce(other({ status: 'completed', deliveries_count: 1 }));
    repo.transition.mockResolvedValue(true);

    await contractsService.approveTacitly(31, NOW);

    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 31,
        changedBy: 7,
        walletEffects: [
          { userId: 44, pendingDelta: -765, balanceDelta: 765, reason: 'escrow_release' },
        ],
      }),
    );
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(44, 31);
  });

  it('prazo estourado com a extensão já usada: marca a contratação certa, e cada cópia vai à sua parte com o que ainda dá para fazer', async () => {
    const r = other({
      deadline_at: brt('2026-10-05 23:59:59'),
      deadline_extended_at: brt('2026-10-01 10:00:00'),
    });
    repo.markOverdueNotified.mockResolvedValue(true);

    expect(await contractsService.notifyOverdue(r, 24, NOW)).toBe(true);

    expect(repo.markOverdueNotified).toHaveBeenCalledWith({
      id: 31,
      deadlineAt: r.deadline_at,
      now: NOW,
      graceEndsAt: brt('2026-10-07 12:00:00'),
    });
    // Entrega única: não há marcos a listar.
    expect(milestonesRepository.titlesByDelivery).not.toHaveBeenCalled();
    expect(notify.mock.calls).toEqual([
      [
        44,
        {
          type: 'contract_overdue',
          title: 'Prazo estourado: Vídeo institucional',
          body: 'Até qua, 07/10 às 12:00: registre a entrega, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. A extensão já foi usada. O prazo era seg, 05/10/2026, até 23:59.',
          data: { contractId: 31 },
        },
        { passCategory: 'deadline' },
      ],
      [
        7,
        {
          type: 'contract_overdue',
          title: 'Prazo estourado: Vídeo institucional',
          body: 'Sem entrega nem extensão aceita até qua, 07/10 às 12:00, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era seg, 05/10/2026, até 23:59 e não houve entrega.',
          data: { contractId: 31 },
        },
        {},
      ],
    ]);
  });

  it('prazo estourado com marco entregue em aberto (esperando o cliente ou em revisão): nenhuma cópia oferece o cancelamento', async () => {
    repo.markOverdueNotified.mockResolvedValue(true);
    for (const open of [{ delivered_awaiting: 1 }, { in_revision: 1 }]) {
      notify.mockClear();
      vi.mocked(milestonesRepository.titlesByDelivery).mockResolvedValueOnce({
        delivered: ['Layout', 'Front'],
        missing: ['Publicação'],
      });
      await contractsService.notifyOverdue(
        other({
          deadline_at: brt('2026-10-05 23:59:59'),
          has_milestones: 1,
          total_milestones: 3,
          undelivered_milestones: 1,
          ...open,
        }),
        24,
        NOW,
      );
      expect(milestonesRepository.titlesByDelivery).toHaveBeenLastCalledWith(31);
      expect(notify.mock.calls[0]![0]).toBe(44);
      expect(notify.mock.calls[0]![1].body).toBe(
        'Até qua, 07/10 às 12:00: entregue o marco «Publicação» ou peça a extensão, senão a disputa abre sozinha. O prazo era seg, 05/10/2026, até 23:59.',
      );
      expect(notify.mock.calls[1]![0]).toBe(7);
      expect(notify.mock.calls[1]![1].body).toBe(
        'Sem as entregas que faltam nem extensão aceita até qua, 07/10 às 12:00, a disputa abre sozinha. O prazo era seg, 05/10/2026, até 23:59: 2 de 3 marcos entregues; falta o marco «Publicação».',
      );
    }
  });

  it('a disputa automática é aberta em nome do cliente, na contratação certa, e avisa as duas partes', async () => {
    const r = other({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:03:00'),
      grace_ends_at: brt('2026-10-04 09:03:00'),
    });
    disputes.create.mockResolvedValueOnce(77);

    expect(await contractsService.openOverdueDispute(r, NOW)).toBe(77);

    expect(disputes.create).toHaveBeenCalledWith(
      {
        ulid: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        contractId: 31,
        openedBy: 7,
        reason: 'deadline',
        description:
          'Aberta automaticamente pela plataforma (RN-029): o prazo de entrega, sex, 02/10/2026, até 23:59 (horário de Brasília), venceu sem entrega, o aviso saiu em 03/10/2026 às 09:03 e, até 04/10/2026 às 09:03, não houve entrega nem extensão aceita. O aviso e o limite estão em horário de Brasília.',
      },
      { guard: 'AND guarda_da_disputa', now: NOW },
    );
    const notice = {
      type: 'dispute_opened',
      title: 'Disputa aberta automaticamente: prazo estourado',
      body: 'Vídeo institucional: sem entrega nem extensão aceita até dom, 04/10 às 09:03, a disputa abriu e a mediação do Escambo decide sobre o valor.',
      data: { contractId: 31, disputeId: 77 },
    };
    expect(notify.mock.calls).toEqual([
      [7, notice, {}],
      [44, notice, {}],
    ]);
  });
});

describe('aceite no instante exato do prazo ou da validade (ADR 57)', () => {
  it('no instante do prazo de entrega ou da validade, a proposta já não pode ser aceita', async () => {
    repo.findById.mockResolvedValue(row({ status: 'pending', deadline_at: NOW }));
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'deadline_passed',
    });
    repo.findById.mockResolvedValue(row({ status: 'pending', proposal_expires_at: NOW }));
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'proposal_expired',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('um segundo antes dos dois, ainda aceita', async () => {
    const soon = new Date(NOW.getTime() + 1000);
    repo.findById.mockResolvedValue(
      row({ status: 'pending', deadline_at: soon, proposal_expires_at: soon }),
    );
    repo.transition.mockResolvedValue(true);
    await contractsService.accept(1, 2);
    expect(repo.transition).toHaveBeenCalledTimes(1);
    expect(flat(repo.transition.mock.calls[0]![0].guard!.sql)).toBe(
      'AND (c.proposal_expires_at IS NULL OR c.proposal_expires_at > :now) AND (c.deadline_at IS NULL OR c.deadline_at > :now)',
    );
  });
});

describe('create: o que é gravado e quem é avisado (RN-021, RN-031)', () => {
  const body = {
    freelancerId: 44,
    serviceId: 5,
    title: 'Vídeo',
    description: 'Roteiro e edição do vídeo',
    price: 199.99,
    paymentMode: 'cash' as const,
  };

  it('grava a proposta em nome do cliente com a comissão vigente, reserva o valor dele e avisa o freelancer até quando responder', async () => {
    settings.mockResolvedValue(72);
    vi.mocked(settingsService.feeRate).mockResolvedValueOnce(0.1);
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(other({ status: 'pending', accepted_at: null }));

    const c = await contractsService.create(7, {
      ...body,
      deadlineAt: '2026-10-20T02:59:59.700Z', // 19/10 23:59:59,7 em Brasília
    });

    // Antes de gravar: o freelancer 44 existe e está ativo, e o serviço 5 é dele e está no ar.
    expect(users.findById.mock.calls).toEqual([[44]]);
    expect(services.findById.mock.calls).toEqual([[5]]);
    // A validade conta no fuso de quem responde, com as horas do painel (72 de padrão); o fuso do
    // cliente entra para dizer o prazo como dia (ADR 58).
    expect(vi.mocked(userZone).mock.calls).toEqual([[44], [7]]);
    expect(settings).toHaveBeenCalledWith('proposal_expiry_hours', 72);
    expect(vi.mocked(walletService.ensure).mock.calls).toEqual([[7]]);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({
      ulid: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      clientId: 7,
      freelancerId: 44,
      serviceId: 5,
      title: 'Vídeo',
      description: 'Roteiro e edição do vídeo',
      price: 199.99,
      // 10% de 199,99 = 19,999, arredondado em centavos (RN-031).
      platformFee: 20,
      freelancerNet: 179.99,
      paymentMode: 'cash',
      // O prazo é gravado sem a fração de segundo.
      deadlineAt: '2026-10-20T02:59:59.000Z',
      proposalExpiresAt: brt('2026-10-09 12:00:00'),
      // O relógio do fluxo: o lembrete da proposta conta a idade daqui (ADR 58).
      createdAt: NOW,
      hold: { userId: 7, amount: 199.99 },
      milestones: null,
    });
    // A resposta é a contratação relida pelo id que o repository devolveu.
    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(c).toMatchObject({ id: 31, clientId: 7, freelancerId: 44 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'contract_proposal',
        title: 'Nova proposta de contratação',
        body: 'Vídeo institucional. Prazo de entrega: seg, 19/10/2026, até 23:59. Responda até sex, 09/10 às 12:00.',
        data: { contractId: 31 },
      },
      {},
    );
  });

  it('sem prazo de entrega, a validade são as horas do painel no fuso de quem responde, e o aviso não fala em prazo', async () => {
    // 20:45 em Brasília já é noite (a validade iria para as 9h); em Manaus ainda são 19:45.
    const at = brt('2026-10-06 20:45:00');
    setClockForTests(at, { frozen: true });
    settings.mockResolvedValue(72);
    vi.mocked(userZone).mockResolvedValueOnce('America/Manaus');
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(
      other({ status: 'pending', accepted_at: null, deadline_at: null }),
    );

    await contractsService.create(7, body);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineAt: null,
        proposalExpiresAt: brt('2026-10-09 20:45:00'),
        // 15% de 199,99 = 29,9985: a taxa padrão do teste.
        platformFee: 30,
        freelancerNet: 169.99,
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        body: 'Vídeo institucional. Responda até sex, 09/10 às 19:45.',
      }),
      {},
    );
  });

  it('sem saldo para reservar: 402, e o freelancer não é avisado de uma proposta que não existe', async () => {
    repo.create.mockResolvedValue(null);
    await expect(contractsService.create(7, body)).rejects.toMatchObject({
      statusCode: 402,
      code: 'insufficient_balance',
    });
    expect(repo.findById).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('a contratação como a API devolve (ADR 57)', () => {
  const at = (s: string): string => brt(s).toISOString();

  it('pedido de extensão esperando o cliente: o prazo fica pausado e o pedido sai inteiro; horas de outras etapas não aparecem', async () => {
    repo.findById.mockResolvedValue(
      other({
        status: 'in_progress',
        service_id: 5,
        extension_status: 'pending',
        extension_requests: 1,
        extension_deadline_at: brt('2026-10-16 23:59:59'),
        extension_reason: 'Atraso do material',
        extension_requested_at: brt('2026-10-06 10:00:00'),
        extension_respond_by: brt('2026-10-08 10:00:00'),
        // Sobras de etapas anteriores: só valem em "pendente" e em "entregue".
        approval_due_at: brt('2026-10-01 09:00:00'),
        proposal_expires_at: brt('2026-10-05 09:00:00'),
      }),
    );

    expect(await contractsService.getById(31, 44)).toEqual({
      id: 31,
      ulid: '01CONTRACT',
      clientId: 7,
      freelancerId: 44,
      serviceId: 5,
      title: 'Vídeo institucional',
      description: 'Roteiro, captação e edição',
      price: 900,
      platformFee: 135,
      freelancerNet: 765,
      paymentMode: 'cash',
      status: 'in_progress',
      deadlineAt: at('2026-10-09 23:59:59'),
      // O prazo é 23:59:59 em Brasília: é o fuso em que ele é um dia (ADR 58).
      deadlineZone: 'America/Sao_Paulo',
      createdAt: at('2026-10-04 10:00:00'),
      hasReview: false,
      hasMilestones: false,
      deadlineExtendedAt: null,
      overdueNotifiedAt: null,
      extension: {
        status: 'pending',
        deadlineAt: at('2026-10-16 23:59:59'),
        reason: 'Atraso do material',
        requestedAt: at('2026-10-06 10:00:00'),
        resolvedAt: null,
        respondBy: at('2026-10-08 10:00:00'),
        seq: 1,
        // A data pedida é 23:59:59 em Brasília: é o dia que as duas partes leem.
        deadlineZone: 'America/Sao_Paulo',
      },
      deadline: {
        state: 'paused',
        noticeAt: null,
        mediationAt: null,
        extensionRequestsLeft: 1,
        undeliveredMilestones: 0,
        totalMilestones: 0,
        firstDeliveredAt: null,
      },
      approvalDueAt: null,
      proposalExpiresAt: null,
      revisionRequestedAt: null,
      history: [],
      review: null,
      milestones: [],
      cancellation: expect.objectContaining({ allowed: true, by: 'freelancer' }),
    });
  });

  it('prazo correndo: o aviso previsto sai às 9h no fuso de quem entrega, e a disputa, depois da carência vigente no painel', async () => {
    vi.mocked(settingsService.number).mockResolvedValueOnce(48);
    repo.findById.mockResolvedValue(other({ freelancer_timezone: 'America/Manaus' }));

    const c = await contractsService.getById(31, 7);

    expect(settingsService.number).toHaveBeenCalledWith('deadline_grace_hours');
    // O prazo (23:59:59 de Brasília) cai às 22:59:59 em Manaus: o aviso vai às 9h de lá (10h de cá).
    expect(c.deadline).toEqual({
      state: 'running',
      noticeAt: at('2026-10-10 10:00:00'),
      mediationAt: at('2026-10-12 10:00:00'),
      extensionRequestsLeft: 2,
      undeliveredMilestones: 0,
      totalMilestones: 0,
      firstDeliveredAt: null,
    });
    expect(c.extension).toBeNull();
  });

  it('entregue: mostra a hora da aprovação tácita, a primeira entrega e se já foi avaliada', async () => {
    repo.findById.mockResolvedValue(
      other({
        status: 'delivered',
        has_review: 1,
        deliveries_count: 1,
        first_delivered_at: brt('2026-10-05 15:00:00'),
        approval_due_at: brt('2026-10-10 15:00:00'),
        proposal_expires_at: brt('2026-10-05 09:00:00'),
      }),
    );

    const c = await contractsService.getById(31, 7);

    expect(c).toMatchObject({
      status: 'delivered',
      hasReview: true,
      approvalDueAt: at('2026-10-10 15:00:00'),
      proposalExpiresAt: null,
      cancellation: null,
    });
    expect(c.deadline).toMatchObject({
      state: 'met',
      extensionRequestsLeft: 0,
      firstDeliveredAt: at('2026-10-05 15:00:00'),
    });
  });

  it('proposta por marcos: mostra a validade (não a aprovação tácita), os marcos contados e busca os marcos da contratação', async () => {
    repo.findById.mockResolvedValue(
      other({
        status: 'pending',
        accepted_at: null,
        has_milestones: 1,
        total_milestones: 3,
        undelivered_milestones: 0,
        proposal_expires_at: brt('2026-10-09 12:00:00'),
        approval_due_at: brt('2026-10-01 09:00:00'),
      }),
    );

    const c = await contractsService.getById(31, 7);

    expect(c).toMatchObject({
      status: 'pending',
      hasMilestones: true,
      approvalDueAt: null,
      proposalExpiresAt: at('2026-10-09 12:00:00'),
    });
    expect(c.deadline).toMatchObject({ state: 'proposal', totalMilestones: 3 });
    expect(milestonesRepository.listForContract).toHaveBeenCalledWith(31);
    // O cancelamento calculado conta só o que ainda está retido nos marcos.
    expect(milestonesRepository.escrowRemaining).toHaveBeenCalledWith(31);
  });

  it('aviso de atraso dado e extensão já aceita: carência com a hora gravada, e as duas datas saem', async () => {
    repo.findById.mockResolvedValue(
      other({
        deadline_at: brt('2026-10-05 23:59:59'),
        deadline_extended_at: brt('2026-10-01 10:00:00'),
        overdue_notified_at: brt('2026-10-06 09:00:00'),
        grace_ends_at: brt('2026-10-07 09:00:00'),
      }),
    );

    const c = await contractsService.getById(31, 7);

    expect(c).toMatchObject({
      deadlineExtendedAt: at('2026-10-01 10:00:00'),
      overdueNotifiedAt: at('2026-10-06 09:00:00'),
    });
    expect(c.deadline).toMatchObject({
      state: 'grace',
      noticeAt: at('2026-10-06 09:00:00'),
      mediationAt: at('2026-10-07 09:00:00'),
      extensionRequestsLeft: 0,
    });
  });
});

describe('cancelamento: a conta e a guarda usam o que a leitura viu (RN-025, ADR 57)', () => {
  const GUARD = [
    'AND c.deadline_at <=> :gDeadline',
    'AND c.overdue_notified_at <=> :gNotice',
    'AND c.extension_status = :gExtStatus',
    'AND c.extension_requests = :gExtRequests',
  ];
  const overdue = (o: Partial<Omit<ContractRow, 'constructor'>> = {}) =>
    other({
      deadline_at: brt('2026-10-02 23:59:59'),
      overdue_notified_at: brt('2026-10-03 09:00:00'),
      grace_ends_at: brt('2026-10-04 09:00:00'),
      extension_status: 'declined',
      extension_requests: 1,
      ...o,
    });

  it('prazo vencido sem entrega, depois do aviso: tudo volta ao cliente, e a gravação repete prazo, aviso e pedido de extensão lidos', async () => {
    const r = overdue();
    repo.findById.mockResolvedValue(r);
    repo.transition.mockResolvedValue(true);

    const result = await contractsService.cancel(31, 7, { expectedRefund: 900 });

    expect(result).toEqual({
      status: 'cancelled',
      refundPercentage: 100,
      stage: 'overdue',
      by: 'client',
      refundClient: 900,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    expect(repo.transition).toHaveBeenCalledTimes(1);
    const call = repo.transition.mock.calls[0]![0];
    expect(call).toEqual({
      id: 31,
      changedBy: 7,
      from: 'accepted',
      to: 'cancelled',
      note: 'Reembolso: 100% (prazo vencido sem entrega)',
      timestampColumn: 'cancelled_at',
      now: NOW,
      closePendingExtension: true,
      guard: {
        // Entrega única: a guarda não fala de marcos.
        sql: GUARD.join('\n'),
        params: {
          gDeadline: r.deadline_at,
          gNotice: r.overdue_notified_at,
          gExtStatus: 'declined',
          gExtRequests: 1,
          gEscrowCents: 90000,
        },
      },
      milestonesTo: CANCEL_MILESTONES,
      walletEffects: [
        { userId: 44, pendingDelta: -765, balanceDelta: 0, reason: 'escrow_refund' },
        { userId: 7, pendingDelta: 0, balanceDelta: 900, reason: 'refund' },
      ],
    });
    expect(milestonesRepository.escrowRemaining).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      44,
      {
        type: 'contract_cancelled',
        title: 'Contratação cancelada pelo cliente: Vídeo institucional',
        body: 'O prazo tinha vencido sem entrega: R$ 900,00 voltou ao cliente.',
        data: { contractId: 31 },
      },
      {},
    );
  });

  it('por marcos: liquida só o que ainda está retido, a guarda trava marco entregue em aberto e confere o escrow, e o aviso não diz "sem entrega"', async () => {
    repo.findById.mockResolvedValue(
      overdue({ has_milestones: 1, total_milestones: 2, undelivered_milestones: 1 }),
    );
    vi.mocked(milestonesRepository.escrowRemaining).mockResolvedValueOnce({
      price: 450,
      net: 382.5,
    });
    repo.transition.mockResolvedValue(true);

    const result = await contractsService.cancel(31, 7);

    expect(milestonesRepository.escrowRemaining).toHaveBeenCalledWith(31);
    expect(result).toMatchObject({ stage: 'overdue', refundClient: 450, releaseFreelancer: 0 });
    const call = repo.transition.mock.calls[0]![0];
    expect(call.walletEffects).toEqual([
      { userId: 44, pendingDelta: -382.5, balanceDelta: 0, reason: 'escrow_refund' },
      { userId: 7, pendingDelta: 0, balanceDelta: 450, reason: 'refund' },
    ]);
    const lines = call.guard!.sql.split('\nAND ').map((l, i) => flat(i === 0 ? l : `AND ${l}`));
    expect(lines).toEqual([
      ...GUARD,
      // Marco entregue esperando o cliente, ou em revisão, trava o cancelamento.
      "AND NOT EXISTS (SELECT 1 FROM contract_milestones m2 WHERE m2.contract_id = c.id AND m2.status IN ('funded', 'delivered') AND m2.delivered_at IS NOT NULL)",
      // O que a pessoa viu retido é o que está retido na hora de gravar.
      "AND ROUND(COALESCE((SELECT SUM(mg.amount) FROM contract_milestones mg WHERE mg.contract_id = c.id AND mg.status IN ('pending', 'funded', 'delivered')), 0) * 100) = :gEscrowCents",
    ]);
    expect(call.guard!.params).toMatchObject({ gEscrowCents: 45000 });
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        body: 'O prazo tinha vencido com marcos nunca entregues: R$ 450,00, o que faltava, voltou ao cliente.',
      }),
      {},
    );
  });

  it('pedido de extensão esperando o cliente com o prazo vencido: responde antes de cancelar', async () => {
    repo.findById.mockResolvedValue(
      other({
        deadline_at: brt('2026-10-05 23:59:59'),
        extension_status: 'pending',
        extension_requests: 1,
        extension_deadline_at: brt('2026-10-16 23:59:59'),
      }),
    );
    await expect(contractsService.cancel(31, 7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'extension_pending_answer',
      message: 'Há um pedido de extensão esperando a sua resposta: responda antes de cancelar.',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('prazo vencido há pouco, antes do aviso das 9h de quem entrega: espera o aviso, e a hora é dita no fuso de quem cancela', async () => {
    setClockForTests(brt('2026-10-06 08:30:00'), { frozen: true });
    const late = { deadline_at: brt('2026-10-05 23:59:59') };

    // Quem entrega em Brasília (aviso às 9h de lá), cliente em Manaus (lê 8h).
    repo.findById.mockResolvedValue(other({ ...late, client_timezone: 'America/Manaus' }));
    await expect(contractsService.cancel(31, 7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'wait_notice',
      message:
        'O prazo venceu há pouco. ter, 06/10 às 08:00 o Escambo avisa o freelancer; a partir daí, cancelar devolve tudo a você.',
    });

    // Quem entrega em Manaus (aviso às 9h de lá, 10h de Brasília), cliente em Brasília.
    repo.findById.mockResolvedValue(other({ ...late, freelancer_timezone: 'America/Manaus' }));
    await expect(contractsService.cancel(31, 7)).rejects.toMatchObject({
      code: 'wait_notice',
      message:
        'O prazo venceu há pouco. ter, 06/10 às 10:00 o Escambo avisa o freelancer; a partir daí, cancelar devolve tudo a você.',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('marco em revisão trava o cancelamento dos dois lados, cada um com a sua mensagem', async () => {
    repo.findById.mockResolvedValue(
      other({ status: 'in_progress', has_milestones: 1, total_milestones: 2, in_revision: 1 }),
    );
    vi.mocked(milestonesRepository.escrowRemaining)
      .mockResolvedValueOnce({ price: 450, net: 382.5 })
      .mockResolvedValueOnce({ price: 450, net: 382.5 });

    await expect(contractsService.cancel(31, 7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'milestone_open',
      message:
        'Há marco em revisão esperando a nova entrega: aguarde ou abra uma disputa antes de cancelar.',
    });
    await expect(contractsService.cancel(31, 44)).rejects.toMatchObject({
      statusCode: 409,
      code: 'milestone_open',
      message:
        'Há marco em revisão esperando você: entregue de novo ou abra uma disputa antes de desistir.',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(vi.mocked(milestonesRepository.escrowRemaining).mock.calls).toEqual([[31], [31]]);
  });

  it('a metade do tempo conta do aceite, não do envio da proposta; e o valor visto confere com folga de meio centavo', async () => {
    // Proposta de 01/09, aceita hoje às 10h, prazo em 09/10: do aceite passaram 2 h de 86 h.
    const r = other({
      created_at: brt('2026-09-01 10:00:00'),
      accepted_at: brt('2026-10-06 10:00:00'),
    });
    repo.findById.mockResolvedValue(r);
    repo.transition.mockResolvedValue(true);

    await expect(contractsService.cancel(31, 7, { expectedRefund: 450.01 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'cancel_quote_changed',
    });
    expect(repo.transition).not.toHaveBeenCalled();

    const result = await contractsService.cancel(31, 7, { expectedRefund: 450.004 });

    expect(result).toEqual({
      status: 'cancelled',
      refundPercentage: 50,
      stage: 'early',
      by: 'client',
      refundClient: 450,
      releaseFreelancer: 382.5,
      unit: 'BRL',
    });
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        note: 'Reembolso: 50% (menos da metade do tempo até o prazo)',
        walletEffects: [
          { userId: 44, pendingDelta: -765, balanceDelta: 382.5, reason: 'escrow_release' },
          { userId: 7, pendingDelta: 0, balanceDelta: 450, reason: 'refund' },
        ],
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        body: 'R$ 382,50 foi liberado na sua carteira e R$ 450,00 voltou ao cliente (reembolso de 50%).',
      }),
      {},
    );
  });

  it('corrida (algo mudou entre a leitura e a gravação): 409 conflict e a outra parte não é avisada', async () => {
    repo.findById.mockResolvedValue(overdue());
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.cancel(31, 7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('o dia do prazo e a revisão em aberto (ADR 58)', () => {
  const at = (s: string): string => brt(s).toISOString();
  const zoneOf = async (o: Partial<Omit<ContractRow, 'constructor'>>) => {
    repo.findById.mockResolvedValue(other(o));
    return (await contractsService.getById(31, 7)).deadlineZone;
  };

  it('o fuso do prazo é o em que ele marca 23:59:59: primeiro o de quem entrega, depois o do cliente, depois um por relógio; sem prazo (ou sem bater), o de quem entrega', async () => {
    // O fim de 09/10 em Manaus, onde está quem entrega.
    expect(
      await zoneOf({
        freelancer_timezone: 'America/Manaus',
        deadline_at: brt('2026-10-10 00:59:59'),
      }),
    ).toBe('America/Manaus');
    // O fim de 09/10 em Brasília, o fuso do cliente.
    expect(
      await zoneOf({
        freelancer_timezone: 'America/Manaus',
        deadline_at: brt('2026-10-09 23:59:59'),
      }),
    ).toBe('America/Sao_Paulo');
    // O fim de 09/10 em Noronha, onde ninguém está: o nome daquele relógio.
    expect(await zoneOf({ deadline_at: brt('2026-10-09 22:59:59') })).toBe('America/Noronha');
    // Cuiabá marca a mesma hora que Manaus: quem entrega em Cuiabá fica com o próprio nome.
    expect(
      await zoneOf({
        freelancer_timezone: 'America/Cuiaba',
        deadline_at: brt('2026-10-10 00:59:59'),
      }),
    ).toBe('America/Cuiaba');
    expect(await zoneOf({ freelancer_timezone: 'America/Manaus', deadline_at: null })).toBe(
      'America/Manaus',
    );
    // Prazo de antes do ADR 58 (20:30 em Brasília): nenhum relógio marca 23:59:59.
    expect(
      await zoneOf({
        freelancer_timezone: 'America/Manaus',
        deadline_at: brt('2026-10-09 20:30:00'),
      }),
    ).toBe('America/Manaus');
  });

  it('a data pedida na extensão é dita no relógio em que ela é 23:59: pedida em Manaus com o prazo em Brasília, o dia é o de Manaus', async () => {
    repo.findById.mockResolvedValue(
      other({
        freelancer_timezone: 'America/Manaus',
        deadline_at: brt('2026-10-09 23:59:59'),
        extension_status: 'pending',
        extension_requests: 1,
        // O fim de 16/10 em Manaus.
        extension_deadline_at: brt('2026-10-17 00:59:59'),
        extension_reason: 'Atraso do material',
        extension_requested_at: brt('2026-10-06 10:00:00'),
        extension_respond_by: brt('2026-10-08 10:00:00'),
      }),
    );

    const c = await contractsService.getById(31, 7);

    expect(c.deadlineZone).toBe('America/Sao_Paulo');
    expect(c.extension!.deadlineZone).toBe('America/Manaus');
  });

  it.each(['pending', 'declined', 'expired'] as const)(
    'pedido %s no mesmo relógio do prazo: vale o fuso do prazo, mesmo com quem entrega em outro',
    async (status) => {
      repo.findById.mockResolvedValue(
        other({
          freelancer_timezone: 'America/Manaus',
          deadline_at: brt('2026-10-09 23:59:59'),
          extension_status: status,
          extension_requests: 1,
          extension_deadline_at: brt('2026-10-16 23:59:59'),
          extension_reason: 'Atraso do material',
          extension_requested_at: brt('2026-10-06 10:00:00'),
          extension_respond_by: brt('2026-10-08 10:00:00'),
          extension_resolved_at: status === 'pending' ? null : brt('2026-10-07 10:00:00'),
        }),
      );

      const c = await contractsService.getById(31, 7);

      expect(c.extension!.status).toBe(status);
      expect(c.extension!.deadlineZone).toBe('America/Sao_Paulo');
      expect(c.extension!.deadlineZone).toBe(c.deadlineZone);
    },
  );

  it('pedido gravado antes das colunas novas (sem motivo, sem hora do pedido e sem contador): sai com os padrões e com o fuso da data pedida', async () => {
    repo.findById.mockResolvedValue(
      other({
        payment_mode: null as unknown as string,
        extension_status: 'declined',
        extension_requests: null as unknown as number,
        extension_deadline_at: brt('2026-10-16 23:59:59'),
        extension_reason: null,
        extension_requested_at: null,
        extension_resolved_at: brt('2026-10-07 10:00:00'),
      }),
    );

    const c = await contractsService.getById(31, 7);

    expect(c.paymentMode).toBe('cash');
    expect(c.extension).toEqual({
      status: 'declined',
      deadlineAt: at('2026-10-16 23:59:59'),
      reason: '',
      requestedAt: at('2026-10-04 10:00:00'),
      resolvedAt: at('2026-10-07 10:00:00'),
      respondBy: null,
      seq: 0,
      deadlineZone: 'America/Sao_Paulo',
    });
  });

  it('no relógio do prazo, a extensão leva o NOME do fuso do prazo (Cuiabá de quem entrega), não o do cliente em Manaus', async () => {
    repo.findById.mockResolvedValue(
      other({
        freelancer_timezone: 'America/Cuiaba',
        client_timezone: 'America/Manaus',
        // O fim de 09/10 e de 16/10 no relógio de Manaus e Cuiabá.
        deadline_at: brt('2026-10-10 00:59:59'),
        extension_status: 'pending',
        extension_requests: 1,
        extension_deadline_at: brt('2026-10-17 00:59:59'),
        extension_reason: 'Atraso do material',
        extension_requested_at: brt('2026-10-06 10:00:00'),
        extension_respond_by: brt('2026-10-08 10:00:00'),
      }),
    );

    const c = await contractsService.getById(31, 7);

    expect(c.deadlineZone).toBe('America/Cuiaba');
    expect(c.extension!.deadlineZone).toBe('America/Cuiaba');
  });

  it('a revisão em aberto diz desde quando, e só enquanto a contratação está em revisão', async () => {
    repo.findById.mockResolvedValue(
      other({
        status: 'revision_requested',
        deliveries_count: 1,
        revision_requested_at: brt('2026-10-05 15:00:00'),
      }),
    );
    expect((await contractsService.getById(31, 7)).revisionRequestedAt).toBe(
      at('2026-10-05 15:00:00'),
    );

    // Entregue de novo: a data que sobrou do pedido não aparece.
    repo.findById.mockResolvedValue(
      other({
        status: 'delivered',
        deliveries_count: 2,
        approval_due_at: brt('2026-10-11 12:00:00'),
        revision_requested_at: brt('2026-10-05 15:00:00'),
      }),
    );
    expect((await contractsService.getById(31, 7)).revisionRequestedAt).toBeNull();
  });

  it('a proposta diz ao freelancer o prazo como dia: no fuso dele se for lá o fim do dia, senão no do cliente, com o fuso anotado', async () => {
    settings.mockResolvedValue(72);
    repo.create.mockResolvedValue(31);
    repo.findById.mockResolvedValue(other({ status: 'pending', accepted_at: null }));
    const propose = (deadlineAt: Date) => {
      // Quem entrega em Manaus; o cliente, em Brasília.
      vi.mocked(userZone).mockResolvedValueOnce('America/Manaus');
      return contractsService.create(7, {
        freelancerId: 44,
        title: 'Vídeo',
        description: 'Roteiro e edição do vídeo',
        price: 100,
        paymentMode: 'cash',
        deadlineAt: deadlineAt.toISOString(),
      });
    };

    // O fim de 20/10 em Manaus.
    await propose(brt('2026-10-21 00:59:59'));
    // O fim de 20/10 em Brasília.
    await propose(brt('2026-10-20 23:59:59'));

    expect(vi.mocked(userZone).mock.calls).toEqual([[44], [7], [44], [7]]);
    // A validade é contada no fuso de quem responde: 72 h depois das 11:00 de Manaus.
    expect(notify.mock.calls.map((c) => [c[0], c[1].body])).toEqual([
      [
        44,
        'Vídeo institucional. Prazo de entrega: ter, 20/10/2026, até 23:59. Responda até sex, 09/10 às 11:00.',
      ],
      [
        44,
        'Vídeo institucional. Prazo de entrega: ter, 20/10/2026, até 23:59 (horário de Brasília). Responda até sex, 09/10 às 11:00.',
      ],
    ]);
  });
});

describe('o dia do prazo quando as partes estão em relógios diferentes (ADR 58)', () => {
  /** O fim de 09/10 em Manaus (00:59:59 de 10/10 em Brasília) e o de 16/10. */
  const END_9_MANAUS = brt('2026-10-10 00:59:59');
  const END_16_MANAUS = brt('2026-10-17 00:59:59');

  it('pedido de extensão: o cliente em Brasília lê o dia pedido em Manaus, com o fuso anotado, e não o dia seguinte', async () => {
    // Quem entrega está em Manaus e escolheu o fim de 16/10 lá; o cliente, em Brasília.
    repo.findById.mockResolvedValue(
      other({ freelancer_timezone: 'America/Manaus', deadline_at: END_9_MANAUS }),
    );
    repo.requestExtension.mockResolvedValue(true);

    await contractsService.requestExtension(31, 44, ask(END_16_MANAUS));

    expect(notify.mock.calls).toEqual([
      [
        7,
        {
          type: 'deadline_extension_requested',
          title: 'Pedido de extensão: Vídeo institucional',
          body: 'Responda até qui, 08/10 às 12:00: novo prazo proposto sex, 16/10/2026, até 23:59 (horário de Manaus). Sem resposta, o pedido expira e vale o prazo atual. Motivo: O material do cliente chegou depois do combinado',
          data: { contractId: 31 },
        },
        {},
      ],
    ]);
  });

  it('aceite da extensão com os prazos no fuso do cliente: a linha do tempo e quem entrega leem os dias de Manaus, e quem entrega com o fuso anotado', async () => {
    // Prazo antigo escolhido no navegador do cliente (Manaus); a extensão, no mesmo fuso do prazo.
    repo.findById.mockResolvedValue(
      other({
        status: 'in_progress',
        client_timezone: 'America/Manaus',
        deadline_at: END_9_MANAUS,
        extension_status: 'pending',
        extension_requests: 1,
        extension_deadline_at: END_16_MANAUS,
        extension_reason: 'Atraso do material',
        extension_requested_at: brt('2026-10-06 10:00:00'),
        extension_respond_by: brt('2026-10-08 10:00:00'),
      }),
    );
    repo.acceptExtension.mockResolvedValue(true);

    await contractsService.resolveExtension(31, 7, true, 1);

    expect(repo.acceptExtension).toHaveBeenCalledWith({
      id: 31,
      seq: 1,
      now: NOW,
      changedBy: 7,
      status: 'in_progress',
      // Em Brasília seriam sáb, 10/10 e sáb, 17/10: os dois dias são os de Manaus.
      note: 'Prazo estendido de sex, 09/10 para sex, 16/10/2026, até 23:59 (horário de Manaus) (RN-028): Atraso do material',
    });
    expect(notify.mock.calls).toEqual([
      [
        44,
        {
          type: 'deadline_extension_accepted',
          title: 'Extensão aceita: novo prazo sex, 16/10',
          body: 'Vídeo institucional: o novo prazo é sex, 16/10/2026, até 23:59 (horário de Manaus); não há outra extensão nesta contratação.',
          data: { contractId: 31 },
        },
        {},
      ],
    ]);
  });

  it('pedido expirado com quem entrega em Manaus e os prazos em Brasília: cada parte lê os mesmos dias, e só quem está no outro relógio lê o fuso', async () => {
    const r = other({
      freelancer_timezone: 'America/Manaus',
      extension_status: 'pending',
      extension_requests: 1,
      extension_deadline_at: brt('2026-10-16 23:59:59'),
      extension_requested_at: brt('2026-10-04 10:00:00'),
      extension_respond_by: brt('2026-10-06 10:00:00'),
    });
    repo.findById.mockResolvedValue({ ...r, extension_status: 'expired' } as ContractRow);
    repo.settleExtension.mockResolvedValue(true);

    expect(await contractsService.expireExtension(r, 24, NOW)).toBe(true);

    expect(notify.mock.calls.map((c) => [c[0], c[1].body])).toEqual([
      [
        44,
        'Vale o prazo atual, sex, 09/10/2026, até 23:59 (horário de Brasília). O cliente não respondeu até ter, 06/10 às 09:00. Você ainda pode fazer mais um pedido.',
      ],
      [
        7,
        'Sem a sua resposta até ter, 06/10 às 10:00, o pedido de novo prazo, sex, 16/10/2026, até 23:59, expirou e vale o prazo atual, sex, 09/10/2026, até 23:59.',
      ],
    ]);
  });

  it('data perto demais logo depois da meia-noite de Brasília (ainda 23:30 em Manaus): o dia sugerido conta do hoje do fuso do prazo', async () => {
    // Prazo no fim de 06/10 em Brasília, o fuso do cliente; quem entrega está em Manaus.
    setClockForTests(brt('2026-10-07 00:30:00'), { frozen: true });
    repo.findById.mockResolvedValue(
      other({ freelancer_timezone: 'America/Manaus', deadline_at: brt('2026-10-06 23:59:59') }),
    );

    await expect(
      contractsService.requestExtension(31, 44, ask(brt('2026-10-07 20:00:00'))),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'extension_too_close',
      // Em Brasília já é 07/10: dois dias depois é 09/10 (em Manaus ainda seria 06/10, e 08/10).
      message:
        'O novo prazo está perto demais para o cliente decidir a tempo: escolha uma data a partir de 09/10/2026.',
    });
    expect(repo.requestExtension).not.toHaveBeenCalled();
  });
});
