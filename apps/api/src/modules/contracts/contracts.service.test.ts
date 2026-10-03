import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: {
    feeRate: vi.fn().mockResolvedValue(0.15),
    number: vi.fn().mockResolvedValue(24),
  },
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn().mockResolvedValue(72) },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../auth/user-zone', () => ({
  userZone: vi.fn().mockResolvedValue('America/Sao_Paulo'),
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    listForContract: vi.fn().mockResolvedValue([]),
    escrowRemaining: vi.fn().mockResolvedValue(null),
    titlesByDelivery: vi.fn().mockResolvedValue({ delivered: [], missing: [] }),
  },
}));

vi.mock('./contracts.repository', () => ({
  contractsRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    listHistory: vi.fn(),
    transition: vi.fn(),
    deliver: vi.fn(),
  },
}));

vi.mock('../wallet/wallet.service', () => ({
  walletService: { ensure: vi.fn(), getBalance: vi.fn() },
}));
vi.mock('../gamification/gamification.service', () => ({
  gamificationService: { onContractCompleted: vi.fn(), onReviewReceived: vi.fn() },
}));
vi.mock('../barter/barter.service', () => ({
  barterService: { onLinkedContractCompleted: vi.fn(), onLinkedContractCancelled: vi.fn() },
}));

import { logger } from '../../config/logger';
import { setClockForTests } from '../../utils/clock';
import { cashSettlement, contractsService } from './contracts.service';
import { contractsRepository, type ContractRow, type HistoryRow } from './contracts.repository';
import { milestonesRepository } from './milestones.repository';
import { barterService } from '../barter/barter.service';
import { gamificationService } from '../gamification/gamification.service';
import { notificationsService } from '../notifications/notifications.service';
import { reviewsRepository } from '../reviews/reviews.repository';
import { walletService } from '../wallet/wallet.service';

// getById anexa a avaliação do contrato; sem banco no teste unitário, vem vazia.
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn().mockResolvedValue(undefined) },
}));

const repo = vi.mocked(contractsRepository);

type FakeFields = Partial<{
  id: number;
  ulid: string;
  client_id: number;
  freelancer_id: number;
  service_id: number | null;
  title: string;
  description: string;
  price: string;
  platform_fee: string;
  freelancer_net: string;
  status: string;
  payment_mode: string;
  deadline_at: Date | null;
  accepted_at: Date | null;
  overdue_notified_at: Date | null;
  created_at: Date;
}>;

function fakeRow(o: FakeFields = {}): ContractRow {
  return {
    id: 1,
    ulid: '01CONTRACTULID000000000000',
    client_id: 1,
    freelancer_id: 2,
    service_id: null,
    title: 'Landing page',
    description: 'Preciso de uma landing page responsiva',
    price: '1000.00',
    platform_fee: '150.00',
    freelancer_net: '850.00',
    status: 'pending',
    payment_mode: 'cash',
    deadline_at: null,
    accepted_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  } as unknown as ContractRow;
}

beforeEach(() => vi.clearAllMocks());

describe('create', () => {
  it('calcula taxa de 15% e líquido (RN-031)', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeRow());
    const contract = await contractsService.create(1, {
      freelancerId: 2,
      title: 'Landing page',
      description: 'Preciso de uma landing page responsiva',
      price: 1000,
      paymentMode: 'cash',
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.platformFee).toBe(150);
    expect(arg.freelancerNet).toBe(850);
    // carteira pré-paga: o valor da proposta é reservado do saldo do cliente já na criação
    expect(arg.hold).toEqual({ userId: 1, amount: 1000 });
    expect(arg).toMatchObject({
      clientId: 1,
      freelancerId: 2,
      serviceId: null,
      price: 1000,
      paymentMode: 'cash',
      deadlineAt: null,
      milestones: null,
    });
    // A carteira do cliente precisa existir antes da reserva.
    expect(vi.mocked(walletService.ensure).mock.calls).toEqual([[1]]);
    expect(contract.status).toBe('pending');
  });

  it('402 quando o cliente não tem saldo para reservar o valor (cash)', async () => {
    repo.create.mockResolvedValue(null);
    await expect(
      contractsService.create(1, {
        freelancerId: 2,
        title: 'Landing page',
        description: 'Preciso de uma landing page responsiva',
        price: 1000,
        paymentMode: 'cash',
      }),
    ).rejects.toMatchObject({ statusCode: 402, code: 'insufficient_balance' });
  });

  it('em créditos não reserva R$ (retenção acontece no aceite)', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeRow());
    await contractsService.create(1, {
      freelancerId: 2,
      title: 'Landing page',
      description: 'Preciso de uma landing page responsiva',
      price: 100,
      paymentMode: 'credits',
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.hold).toBeNull();
    // Time-bank é entre pessoas: sem taxa da plataforma, o líquido é o próprio valor.
    expect(arg).toMatchObject({ paymentMode: 'credits', platformFee: 0, freelancerNet: 100 });
    expect(walletService.ensure).not.toHaveBeenCalled();
  });

  it('bloqueia auto-contratação (400)', async () => {
    await expect(
      contractsService.create(5, {
        freelancerId: 5,
        title: 'X qualquer',
        description: 'descrição bem longa aqui',
        price: 100,
        paymentMode: 'cash',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'self_contract' });
    expect(repo.create).not.toHaveBeenCalled();
    expect(walletService.ensure).not.toHaveBeenCalled();
  });
});

describe('accept', () => {
  it('403 se não for o freelancer', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'pending' }));
    await expect(contractsService.accept(1, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Ação exclusiva do freelancer',
    });
    // O cliente também não aceita a própria proposta.
    await expect(contractsService.accept(1, 1)).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('409 se status não for pending', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'accepted' }));
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'Ação não permitida no status "accepted"',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('transiciona pending -> accepted', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ freelancer_id: 2, status: 'pending' }))
      .mockResolvedValueOnce(fakeRow({ freelancer_id: 2, status: 'accepted' }));
    repo.transition.mockResolvedValue(true);
    const c = await contractsService.accept(1, 2);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'pending',
        to: 'accepted',
        timestampColumn: 'accepted_at',
        changedBy: 2,
        // o valor reservado do cliente (1000) paga a contratação; o líquido (850) entra em
        // escrow do freelancer; a diferença (150) é a taxa da plataforma
        walletEffects: [
          { userId: 1, pendingDelta: -1000, balanceDelta: 0, reason: 'payment' },
          { userId: 2, pendingDelta: 850, balanceDelta: 0, reason: 'escrow_in' },
        ],
      }),
    );
    expect(c.status).toBe('accepted');
  });

  it('recusa devolve ao cliente o valor reservado', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ freelancer_id: 2, status: 'pending' }))
      .mockResolvedValueOnce(fakeRow({ freelancer_id: 2, status: 'rejected' }));
    repo.transition.mockResolvedValue(true);
    await contractsService.reject(1, 2);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'rejected',
        walletEffects: [{ userId: 1, pendingDelta: -1000, balanceDelta: 1000, reason: 'refund' }],
      }),
    );
  });

  it('409 em corrida (transition retorna false)', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'pending' }));
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
  });
});

describe('approve', () => {
  it('403 se não for o cliente', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'delivered' }));
    await expect(contractsService.approve(1, 2)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Ação exclusiva do cliente',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('só se aprova o que foi entregue: fora de delivered, 409 e o escrow não se move', async () => {
    for (const status of [
      'pending',
      'accepted',
      'in_progress',
      'revision_requested',
      'completed',
    ]) {
      repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status }));
      await expect(contractsService.approve(1, 1), status).rejects.toMatchObject({
        statusCode: 409,
        code: 'invalid_transition',
      });
    }
    expect(repo.transition).not.toHaveBeenCalled();
    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();
  });

  it('delivered -> completed', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ client_id: 1, status: 'delivered' }))
      .mockResolvedValueOnce(fakeRow({ client_id: 1, status: 'completed' }));
    repo.transition.mockResolvedValue(true);
    const c = await contractsService.approve(1, 1);
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'completed',
        timestampColumn: 'completed_at',
        // escrow liberado: pendente -> disponível
        walletEffects: [
          { userId: 2, pendingDelta: -850, balanceDelta: 850, reason: 'escrow_release' },
        ],
      }),
    );
    expect(c.status).toBe('completed');
  });
});

describe('deliver', () => {
  it('403 se não for o freelancer', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'accepted' }));
    await expect(contractsService.deliver(1, 99, { message: 'pronto' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    // Nem o cliente registra entrega (RF-035).
    await expect(contractsService.deliver(1, 1, { message: 'pronto' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repo.deliver).not.toHaveBeenCalled();
  });

  it('registra entrega e vai para delivered', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ freelancer_id: 2, status: 'accepted' }))
      .mockResolvedValueOnce(fakeRow({ freelancer_id: 2, status: 'delivered' }));
    repo.deliver.mockResolvedValue(true);
    const c = await contractsService.deliver(1, 2, {
      message: 'entregue',
      files: ['https://cdn/x.png'],
    });
    expect(repo.deliver).toHaveBeenCalledTimes(1);
    expect(repo.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        changedBy: 2,
        from: 'accepted',
        message: 'entregue',
        files: ['https://cdn/x.png'],
      }),
    );
    expect(c.status).toBe('delivered');
  });
});

describe('cancel (RN-025)', () => {
  it('quem não participa da contratação não cancela: 403 e nada se move', async () => {
    repo.findById.mockResolvedValue(
      fakeRow({ client_id: 1, freelancer_id: 2, status: 'accepted' }),
    );
    await expect(contractsService.cancel(1, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Você não participa desta contratação',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(notificationsService.notify).not.toHaveBeenCalled();
  });

  it('contratação que não existe: 404', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(contractsService.cancel(404, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'contract_not_found',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('reembolso 100% em pending', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'pending' }));
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r.refundPercentage).toBe(100);
    expect(r.status).toBe('cancelled');
    // só existia a reserva do cliente: volta integralmente
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        walletEffects: [{ userId: 1, pendingDelta: -1000, balanceDelta: 1000, reason: 'refund' }],
      }),
    );
  });

  it('reembolso 50% em accepted com < 50% do prazo', async () => {
    const created = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h atrás
    const deadline = new Date(Date.now() + 9 * 60 * 60 * 1000); // ~10% decorrido
    repo.findById.mockResolvedValue(
      fakeRow({ client_id: 1, status: 'accepted', created_at: created, deadline_at: deadline }),
    );
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r.refundPercentage).toBe(50);
    // escrow liquidado meio a meio: freelancer fica com 50% do líquido, cliente recebe 50% do preço
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        walletEffects: [
          { userId: 2, pendingDelta: -850, balanceDelta: 425, reason: 'escrow_release' },
          { userId: 1, pendingDelta: 0, balanceDelta: 500, reason: 'refund' },
        ],
      }),
    );
  });

  it('reembolso 0% em accepted com >= 50% do prazo', async () => {
    const created = new Date(Date.now() - 9 * 60 * 60 * 1000);
    const deadline = new Date(Date.now() + 1 * 60 * 60 * 1000); // ~90% decorrido
    repo.findById.mockResolvedValue(
      fakeRow({ client_id: 1, status: 'accepted', created_at: created, deadline_at: deadline }),
    );
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r.refundPercentage).toBe(0);
    // nada volta ao cliente; o freelancer recebe o líquido inteiro
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        walletEffects: [
          { userId: 2, pendingDelta: -850, balanceDelta: 850, reason: 'escrow_release' },
        ],
      }),
    );
  });

  it('409 ao cancelar após a entrega, com a mensagem do que fazer', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'delivered' }));
    await expect(contractsService.cancel(1, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
      message: 'Depois da entrega não se cancela: aprove, peça revisão ou abra uma disputa.',
    });
  });

  it('o freelancer que desiste devolve tudo ao cliente e o cliente é avisado (RN-026)', async () => {
    repo.findById.mockResolvedValue(
      fakeRow({ client_id: 1, freelancer_id: 2, status: 'accepted', accepted_at: new Date() }),
    );
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 2);
    expect(r).toMatchObject({ stage: 'withdrawal', by: 'freelancer', refundClient: 1000 });
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        closePendingExtension: true,
        walletEffects: [
          { userId: 2, pendingDelta: -850, balanceDelta: 0, reason: 'escrow_refund' },
          { userId: 1, pendingDelta: 0, balanceDelta: 1000, reason: 'refund' },
        ],
      }),
    );
    expect(vi.mocked(notificationsService.notify)).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'contract_cancelled',
        title: 'O freelancer desistiu: Landing page',
      }),
      {},
    );
  });

  it('prazo vencido sem entrega, depois do aviso: o cliente recebe tudo (antes recebia 0%)', async () => {
    const hour = 3_600_000;
    repo.findById.mockResolvedValue(
      fakeRow({
        client_id: 1,
        status: 'accepted',
        accepted_at: new Date(Date.now() - 100 * hour),
        deadline_at: new Date(Date.now() - 30 * hour),
        overdue_notified_at: new Date(Date.now() - 20 * hour),
      }),
    );
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r).toMatchObject({ stage: 'overdue', refundPercentage: 100, refundClient: 1000 });
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        note: 'Reembolso: 100% (prazo vencido sem entrega)',
        walletEffects: [
          { userId: 2, pendingDelta: -850, balanceDelta: 0, reason: 'escrow_refund' },
          { userId: 1, pendingDelta: 0, balanceDelta: 1000, reason: 'refund' },
        ],
      }),
    );
  });

  it('o valor visto na tela é conferido: mudou, 409 e nada se move', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'pending' }));
    await expect(contractsService.cancel(1, 1, { expectedRefund: 500 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'cancel_quote_changed',
    });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(notificationsService.notify).not.toHaveBeenCalled();
  });

  it('a gravação repete o que a leitura viu (prazo, aviso e pedido de extensão)', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'pending' }));
    repo.transition.mockResolvedValue(true);
    await contractsService.cancel(1, 1, { expectedRefund: 1000 });
    const call = repo.transition.mock.calls[0]![0];
    expect(call.guard?.sql).toContain('c.deadline_at <=> :gDeadline');
    expect(call.guard?.sql).toContain('c.extension_requests = :gExtRequests');
    expect(call.guard?.params).toMatchObject({ gDeadline: null, gNotice: null, gExtRequests: 0 });
  });
});

describe('cashSettlement (liquidação proporcional do escrow)', () => {
  it('divide preço, líquido e taxa na mesma proporção', () => {
    expect(cashSettlement(1000, 850, 0)).toEqual({ refundClient: 0, releaseFreelancer: 850 });
    expect(cashSettlement(1000, 850, 100)).toEqual({ refundClient: 1000, releaseFreelancer: 0 });
    expect(cashSettlement(1000, 850, 40)).toEqual({ refundClient: 400, releaseFreelancer: 510 });
    // cliente + freelancer + taxa retida (fração) fecham o preço, sem sobra
    const s = cashSettlement(300, 255, 50);
    expect(s.refundClient + s.releaseFreelancer + 45 * 0.5).toBe(300);
  });

  it('arredonda em centavos e limita o percentual a 0–100', () => {
    expect(cashSettlement(99.99, 84.99, 33)).toEqual({
      refundClient: 33,
      releaseFreelancer: 56.94,
    });
    expect(cashSettlement(100, 85, 150)).toEqual({ refundClient: 100, releaseFreelancer: 0 });
  });
});

describe('getById', () => {
  it('403 se não participa', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, freelancer_id: 2 }));
    await expect(contractsService.getById(1, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Você não participa desta contratação',
    });
    // Quem não participa não chega nem à linha do tempo.
    expect(repo.listHistory).not.toHaveBeenCalled();
  });

  it('retorna contrato com histórico', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, freelancer_id: 2, status: 'pending' }));
    repo.listHistory.mockResolvedValue([
      {
        old_status: null,
        new_status: 'pending',
        note: 'Proposta enviada',
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
    ] as unknown as HistoryRow[]);
    const c = await contractsService.getById(1, 1);
    expect(c.history).toEqual([
      {
        previousStatus: null,
        status: 'pending',
        note: 'Proposta enviada',
        at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(repo.listHistory).toHaveBeenCalledWith(1);
    expect(reviewsRepository.findByContractIdWithResponse).toHaveBeenCalledWith(1);
    // Sem marcos, nem consulta a tabela deles.
    expect(c.milestones).toEqual([]);
    expect(milestonesRepository.listForContract).not.toHaveBeenCalled();
    expect(milestonesRepository.escrowRemaining).not.toHaveBeenCalled();
  });

  it('o cancelamento calculado só acompanha a contratação enquanto ela pode ser cancelada', async () => {
    repo.listHistory.mockResolvedValue([]);
    for (const status of ['pending', 'accepted', 'in_progress']) {
      repo.findById.mockResolvedValue(fakeRow({ status }));
      expect((await contractsService.getById(1, 1)).cancellation, status).toMatchObject({
        allowed: true,
        by: 'client',
      });
    }
    for (const status of [
      'delivered',
      'revision_requested',
      'completed',
      'cancelled',
      'rejected',
      'disputed',
    ]) {
      repo.findById.mockResolvedValue(fakeRow({ status }));
      expect((await contractsService.getById(1, 1)).cancellation, status).toBeNull();
    }
  });

  it('enquanto dá para cancelar, o detalhe já traz o cancelamento calculado para quem está vendo', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, freelancer_id: 2, status: 'pending' }));
    repo.listHistory.mockResolvedValue([]);

    // O cliente retira a proposta e a reserva volta inteira; o freelancer usa Recusar.
    expect((await contractsService.getById(1, 1)).cancellation).toMatchObject({
      allowed: true,
      by: 'client',
      stage: 'proposal',
      refundClient: 1000,
    });
    expect((await contractsService.getById(1, 2)).cancellation).toMatchObject({
      allowed: false,
      by: 'freelancer',
      code: 'use_reject',
    });
  });

  it('contratação concluída não tem cancelamento, e a avaliação do cliente vem junto com a resposta', async () => {
    repo.findById.mockResolvedValue(
      fakeRow({ client_id: 1, freelancer_id: 2, status: 'completed' }),
    );
    repo.listHistory.mockResolvedValue([]);
    vi.mocked(reviewsRepository.findByContractIdWithResponse).mockResolvedValueOnce({
      id: 9,
      contract_id: 1,
      reviewer_id: 1,
      reviewee_id: 2,
      rating: 5,
      comment: 'Ótimo trabalho',
      response: 'Obrigado',
      removed_at: null,
      created_at: new Date('2026-01-10T12:00:00Z'),
    } as never);

    const c = await contractsService.getById(1, 2);

    expect(c.cancellation).toBeNull();
    expect(c.review).toEqual({
      id: 9,
      contractId: 1,
      reviewerId: 1,
      revieweeId: 2,
      rating: 5,
      comment: 'Ótimo trabalho',
      response: 'Obrigado',
      createdAt: '2026-01-10T12:00:00.000Z',
      removedAt: null,
    });
    expect(c.milestones).toEqual([]);
  });

  it('404 quando a contratação não existe', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(contractsService.getById(404, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'contract_not_found',
    });
  });
});

describe('listMine', () => {
  it('pagina as contratações de quem está logado e devolve cada uma no formato da API', async () => {
    repo.listForUser.mockResolvedValue([
      fakeRow({ id: 9, status: 'accepted' }),
      fakeRow({ id: 8 }),
    ]);

    const page = await contractsService.listMine(7, { page: 3, limit: 20 });

    // Página 3 de 20 em 20: pula as 40 primeiras.
    expect(repo.listForUser).toHaveBeenCalledWith(7, 20, 40);
    expect(page.page).toBe(3);
    expect(page.limit).toBe(20);
    expect(page.items.map((c) => [c.id, c.status, c.price, c.freelancerNet])).toEqual([
      [9, 'accepted', 1000, 850],
      [8, 'pending', 1000, 850],
    ]);
  });
});

/** Contratação em créditos (time-bank): 40 créditos, sem taxa da plataforma. */
const creditsRow = (o: FakeFields = {}): ContractRow =>
  fakeRow({
    payment_mode: 'credits',
    price: '40.00',
    platform_fee: '0.00',
    freelancer_net: '40.00',
    ...o,
  });

/** Contratação que faz parte de um acordo de troca (não move dinheiro). */
const barterRow = (o: FakeFields = {}): ContractRow =>
  ({ ...fakeRow({ payment_mode: 'barter', ...o }), barter_agreement_id: 9 }) as ContractRow;

describe('accept em créditos (time-bank)', () => {
  it('os créditos saem do cliente e ficam retidos para o freelancer na mesma transição, sem mexer em R$', async () => {
    repo.findById
      .mockResolvedValueOnce(creditsRow())
      .mockResolvedValueOnce(creditsRow({ status: 'accepted' }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.accept(1, 2);

    // As duas carteiras precisam existir antes do movimento.
    expect(vi.mocked(walletService.ensure).mock.calls).toEqual([[1], [2]]);
    const call = repo.transition.mock.calls[0]![0];
    expect(call).toMatchObject({
      id: 1,
      changedBy: 2,
      from: 'pending',
      to: 'accepted',
      timestampColumn: 'accepted_at',
      milestonesTo: { from: ['pending'], to: 'funded' },
    });
    expect(call.creditsEffects).toEqual([
      { userId: 1, pendingDelta: 0, balanceDelta: -40, reason: 'escrow_hold' },
      { userId: 2, pendingDelta: 40, balanceDelta: 0, reason: 'escrow_in' },
    ]);
    expect(call.walletEffects).toBeUndefined();
    expect(c).toMatchObject({ status: 'accepted', paymentMode: 'credits' });
  });

  it('cliente sem créditos (ou contratação que mudou no meio): 409 insufficient_credits', async () => {
    repo.findById.mockResolvedValue(creditsRow());
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'insufficient_credits',
    });
  });
});

describe('requestRevision (entrega única)', () => {
  it('só o cliente pede revisão, e só de uma entrega registrada', async () => {
    repo.findById.mockResolvedValue(fakeRow({ status: 'delivered' }));
    await expect(contractsService.requestRevision(1, 2, 'x')).rejects.toMatchObject({
      statusCode: 403,
    });
    repo.findById.mockResolvedValue(fakeRow({ status: 'accepted' }));
    await expect(contractsService.requestRevision(1, 1, 'x')).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('volta para revisão com a nota na linha do tempo e avisa quem entrega', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeRow({ status: 'delivered' }))
      .mockResolvedValueOnce(fakeRow({ status: 'revision_requested' }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.requestRevision(1, 1, 'Trocar a cor do botão');

    expect(repo.transition).toHaveBeenCalledWith({
      id: 1,
      changedBy: 1,
      from: 'delivered',
      to: 'revision_requested',
      note: 'Trocar a cor do botão',
    });
    // Depois da entrega o prazo não cobra mais: aviso simples, sem furar o silêncio.
    expect(vi.mocked(notificationsService.notify)).toHaveBeenCalledWith(
      2,
      {
        type: 'contract_revision',
        title: 'Revisão pedida: Landing page',
        body: 'Trocar a cor do botão',
        data: { contractId: 1 },
      },
      {},
    );
    expect(c.status).toBe('revision_requested');
  });

  it('corrida (a entrega já saiu de delivered): 409 conflict e ninguém é avisado', async () => {
    repo.findById.mockResolvedValue(fakeRow({ status: 'delivered' }));
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.requestRevision(1, 1, null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(vi.mocked(notificationsService.notify)).not.toHaveBeenCalled();
  });
});

describe('reject', () => {
  it('só o freelancer recusa, e só uma proposta ainda pendente', async () => {
    repo.findById.mockResolvedValue(fakeRow({ status: 'pending' }));
    await expect(contractsService.reject(1, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Ação exclusiva do freelancer',
    });
    repo.findById.mockResolvedValue(fakeRow({ status: 'accepted' }));
    await expect(contractsService.reject(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_transition',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('proposta em créditos recusada não move R$: nada tinha sido reservado', async () => {
    repo.findById
      .mockResolvedValueOnce(creditsRow())
      .mockResolvedValueOnce(creditsRow({ status: 'rejected' }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.reject(1, 2);

    const call = repo.transition.mock.calls[0]![0];
    expect(call.walletEffects).toEqual([]);
    expect(call.creditsEffects).toBeUndefined();
    expect(c.status).toBe('rejected');
  });

  it('corrida (a proposta já saiu de pendente): 409 conflict', async () => {
    repo.findById.mockResolvedValue(fakeRow({ status: 'pending' }));
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.reject(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
  });
});

/**
 * Ids que não se repetem (contratação 31, cliente 7, freelancer 44): nos exemplos acima a
 * contratação e o cliente têm o mesmo número, e uma troca entre os dois passaria despercebida.
 */
describe('quem age, quem paga e quem é avisado', () => {
  const AT = new Date('2026-10-06T15:00:00.000Z');
  const other = (o: FakeFields = {}): ContractRow =>
    fakeRow({ id: 31, client_id: 7, freelancer_id: 44, ...o });
  const CANCEL_MILESTONES = { from: ['pending', 'funded', 'delivered'], to: 'cancelled' };
  const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

  beforeEach(() => setClockForTests(AT, { frozen: true }));
  afterEach(() => setClockForTests(null));

  it('o aceite em dinheiro paga com a reserva do cliente, põe o líquido em garantia para o freelancer e a guarda repete a validade e o prazo', async () => {
    repo.findById
      .mockResolvedValueOnce(other())
      .mockResolvedValueOnce(other({ status: 'accepted' }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.accept(31, 44);

    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    // Só a carteira de quem recebe precisa ser criada: a do cliente já tem a reserva.
    expect(vi.mocked(walletService.ensure).mock.calls).toEqual([[44]]);
    expect(repo.transition).toHaveBeenCalledTimes(1);
    expect(repo.transition).toHaveBeenCalledWith({
      id: 31,
      changedBy: 44,
      from: 'pending',
      to: 'accepted',
      note: null,
      timestampColumn: 'accepted_at',
      now: AT,
      guard: { sql: expect.any(String) },
      milestonesTo: { from: ['pending'], to: 'funded' },
      walletEffects: [
        { userId: 7, pendingDelta: -1000, balanceDelta: 0, reason: 'payment' },
        { userId: 44, pendingDelta: 850, balanceDelta: 0, reason: 'escrow_in' },
      ],
    });
    // A hora avisada é a cumprida: nem depois da validade, nem depois do prazo.
    expect(flat(repo.transition.mock.calls[0]![0].guard!.sql)).toBe(
      'AND (c.proposal_expires_at IS NULL OR c.proposal_expires_at > :now) AND (c.deadline_at IS NULL OR c.deadline_at > :now)',
    );
    expect(c).toMatchObject({ id: 31, clientId: 7, freelancerId: 44, status: 'accepted' });
  });

  it('a recusa devolve a reserva ao cliente, cancela os marcos e fica na linha do tempo em nome do freelancer', async () => {
    repo.findById
      .mockResolvedValueOnce(other())
      .mockResolvedValueOnce(other({ status: 'rejected' }));
    repo.transition.mockResolvedValue(true);

    const c = await contractsService.reject(31, 44);

    expect(repo.findById.mock.calls).toEqual([[31], [31]]);
    expect(repo.transition).toHaveBeenCalledWith({
      id: 31,
      changedBy: 44,
      from: 'pending',
      to: 'rejected',
      note: null,
      walletEffects: [{ userId: 7, pendingDelta: -1000, balanceDelta: 1000, reason: 'refund' }],
      milestonesTo: CANCEL_MILESTONES,
    });
    expect(c).toMatchObject({ id: 31, status: 'rejected' });
  });

  it('a aprovação fica em nome do cliente, libera o líquido ao freelancer e dá o XP da contratação certa', async () => {
    repo.findById
      .mockResolvedValueOnce(other({ status: 'delivered' }))
      .mockResolvedValueOnce(other({ status: 'completed' }));
    repo.transition.mockResolvedValue(true);

    await contractsService.approve(31, 7);

    expect(repo.transition).toHaveBeenCalledWith({
      id: 31,
      changedBy: 7,
      from: 'delivered',
      to: 'completed',
      note: null,
      timestampColumn: 'completed_at',
      now: AT,
      // A aprovação manual não tem hora-limite a repetir (a tácita tem).
      guard: undefined,
      walletEffects: [
        { userId: 44, pendingDelta: -850, balanceDelta: 850, reason: 'escrow_release' },
      ],
    });
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(44, 31);
  });

  it('o cliente retira a proposta: a reserva volta a ele, o freelancer é avisado e a gravação repete o que a leitura viu', async () => {
    repo.findById.mockResolvedValue(other());
    repo.transition.mockResolvedValue(true);

    const r = await contractsService.cancel(31, 7, { expectedRefund: 1000 });

    expect(r).toEqual({
      status: 'cancelled',
      refundPercentage: 100,
      stage: 'proposal',
      by: 'client',
      refundClient: 1000,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(repo.transition).toHaveBeenCalledWith({
      id: 31,
      changedBy: 7,
      from: 'pending',
      to: 'cancelled',
      note: 'Reembolso: 100% (proposta cancelada antes do aceite)',
      timestampColumn: 'cancelled_at',
      now: AT,
      closePendingExtension: true,
      guard: {
        // Sem marcos, a guarda não fala de marcos.
        sql: [
          'AND c.deadline_at <=> :gDeadline',
          'AND c.overdue_notified_at <=> :gNotice',
          'AND c.extension_status = :gExtStatus',
          'AND c.extension_requests = :gExtRequests',
        ].join('\n'),
        params: {
          gDeadline: null,
          gNotice: null,
          gExtStatus: undefined,
          gExtRequests: 0,
          gEscrowCents: 100000,
        },
      },
      milestonesTo: CANCEL_MILESTONES,
      walletEffects: [{ userId: 7, pendingDelta: -1000, balanceDelta: 1000, reason: 'refund' }],
    });
    expect(notificationsService.notify).toHaveBeenCalledTimes(1);
    expect(notificationsService.notify).toHaveBeenCalledWith(
      44,
      {
        type: 'contract_cancelled',
        title: 'Proposta retirada: Landing page',
        body: 'O cliente cancelou a proposta antes do aceite.',
        data: { contractId: 31 },
      },
      {},
    );
  });

  it('o freelancer desiste: o que estava em garantia sai dele, o preço volta ao cliente e é o cliente quem é avisado (RN-026)', async () => {
    repo.findById.mockResolvedValue(other({ status: 'in_progress', accepted_at: AT }));
    repo.transition.mockResolvedValue(true);

    const r = await contractsService.cancel(31, 44);

    expect(r).toMatchObject({ by: 'freelancer', stage: 'withdrawal', refundClient: 1000 });
    expect(repo.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 31,
        changedBy: 44,
        from: 'in_progress',
        to: 'cancelled',
        note: 'Reembolso: 100% (o freelancer desistiu)',
        timestampColumn: 'cancelled_at',
        walletEffects: [
          { userId: 44, pendingDelta: -850, balanceDelta: 0, reason: 'escrow_refund' },
          { userId: 7, pendingDelta: 0, balanceDelta: 1000, reason: 'refund' },
        ],
      }),
    );
    expect(notificationsService.notify).toHaveBeenCalledTimes(1);
    expect(notificationsService.notify).toHaveBeenCalledWith(
      7,
      {
        type: 'contract_cancelled',
        title: 'O freelancer desistiu: Landing page',
        body: 'R$ 1.000,00 voltou para a sua carteira.',
        data: { contractId: 31 },
      },
      {},
    );
  });

  it('o detalhe busca a linha do tempo e a avaliação da contratação pedida', async () => {
    repo.findById.mockResolvedValue(other());
    repo.listHistory.mockResolvedValue([]);

    const c = await contractsService.getById(31, 44);

    expect(repo.findById).toHaveBeenCalledWith(31);
    expect(repo.listHistory).toHaveBeenCalledWith(31);
    expect(reviewsRepository.findByContractIdWithResponse).toHaveBeenCalledWith(31);
    expect(c).toMatchObject({ id: 31, clientId: 7, freelancerId: 44 });
  });
});

describe('cancel em créditos e em troca', () => {
  it('depois do aceite, os créditos em garantia voltam inteiros ao cliente, sem mexer em R$', async () => {
    repo.findById.mockResolvedValue(creditsRow({ status: 'accepted', accepted_at: new Date() }));
    repo.transition.mockResolvedValue(true);

    const r = await contractsService.cancel(1, 1);

    expect(r).toEqual({
      status: 'cancelled',
      refundPercentage: 100,
      stage: 'credits',
      by: 'client',
      refundClient: 40,
      releaseFreelancer: 0,
      unit: 'credits',
    });
    const call = repo.transition.mock.calls[0]![0];
    expect(call.note).toBe('Reembolso: 100% (créditos em garantia)');
    expect(call.creditsEffects).toEqual([
      { userId: 2, pendingDelta: -40, balanceDelta: 0, reason: 'escrow_refund' },
      { userId: 1, pendingDelta: 0, balanceDelta: 40, reason: 'refund' },
    ]);
    expect(call.walletEffects).toBeUndefined();
    expect(vi.mocked(notificationsService.notify)).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        title: 'Contratação cancelada pelo cliente: Landing page',
        body: 'Os 40 créditos em garantia voltaram ao cliente.',
      }),
      {},
    );
  });

  it('proposta em créditos retirada antes do aceite não move nada: os créditos só são retidos no aceite', async () => {
    repo.findById.mockResolvedValue(creditsRow({ status: 'pending' }));
    repo.transition.mockResolvedValue(true);

    const r = await contractsService.cancel(1, 1);

    expect(r).toMatchObject({ stage: 'proposal', unit: 'credits', refundClient: 0 });
    const call = repo.transition.mock.calls[0]![0];
    expect(call.walletEffects).toEqual([]);
    expect(call.creditsEffects).toBeUndefined();
  });

  it('troca: cancela sem mover dinheiro e avisa o acordo de troca', async () => {
    repo.findById.mockResolvedValue(barterRow({ status: 'accepted', accepted_at: new Date() }));
    repo.transition.mockResolvedValue(true);

    const r = await contractsService.cancel(1, 1);

    expect(r).toMatchObject({
      status: 'cancelled',
      stage: 'barter',
      unit: 'none',
      refundPercentage: 0,
      refundClient: 0,
      releaseFreelancer: 0,
    });
    const call = repo.transition.mock.calls[0]![0];
    expect(call.note).toBe('Reembolso: 0% (contratação de troca)');
    expect(call.walletEffects).toBeUndefined();
    expect(call.creditsEffects).toBeUndefined();
    expect(barterService.onLinkedContractCancelled).toHaveBeenCalledWith(9);
  });

  it('se o acordo de troca falha ao ser avisado, o cancelamento já gravado vale e o erro vai para o log', async () => {
    const boom = new Error('acordo travado');
    repo.findById.mockResolvedValue(barterRow({ status: 'accepted', accepted_at: new Date() }));
    repo.transition.mockResolvedValue(true);
    vi.mocked(barterService.onLinkedContractCancelled).mockRejectedValueOnce(boom);
    const warn = vi.spyOn(logger, 'warn');

    await expect(contractsService.cancel(1, 1)).resolves.toMatchObject({ status: 'cancelled' });

    expect(warn).toHaveBeenCalledWith({ err: boom }, 'troca (onLinkedContractCancelled) falhou');
    warn.mockRestore();
  });

  it('contratação comum não avisa acordo de troca nenhum', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'pending' }));
    repo.transition.mockResolvedValue(true);
    await contractsService.cancel(1, 1);
    expect(barterService.onLinkedContractCancelled).not.toHaveBeenCalled();
  });
});

describe('depois da conclusão (XP e troca)', () => {
  it('em créditos, a aprovação libera os créditos retidos do freelancer, não R$, e dá o XP', async () => {
    repo.findById
      .mockResolvedValueOnce(creditsRow({ status: 'delivered' }))
      .mockResolvedValueOnce(creditsRow({ status: 'completed' }));
    repo.transition.mockResolvedValue(true);

    await contractsService.approve(1, 1);

    const call = repo.transition.mock.calls[0]![0];
    expect(call.creditsEffects).toEqual([{ userId: 2, pendingDelta: -40, balanceDelta: 40 }]);
    expect(call.walletEffects).toBeUndefined();
    expect(gamificationService.onContractCompleted).toHaveBeenCalledWith(2, 1);
    expect(barterService.onLinkedContractCompleted).not.toHaveBeenCalled();
  });

  it('troca: a aprovação não move dinheiro e conclui o lado do acordo de troca', async () => {
    repo.findById
      .mockResolvedValueOnce(barterRow({ status: 'delivered' }))
      .mockResolvedValueOnce(barterRow({ status: 'completed' }));
    repo.transition.mockResolvedValue(true);

    await contractsService.approve(1, 1);

    const call = repo.transition.mock.calls[0]![0];
    expect(call).toMatchObject({ from: 'delivered', to: 'completed' });
    expect(call.walletEffects).toBeUndefined();
    expect(call.creditsEffects).toBeUndefined();
    expect(barterService.onLinkedContractCompleted).toHaveBeenCalledWith(9);
  });

  it('falha na gamificação ou na troca não derruba a aprovação: o escrow já foi liberado', async () => {
    const xp = new Error('xp fora do ar');
    const barter = new Error('acordo travado');
    repo.findById
      .mockResolvedValueOnce(barterRow({ status: 'delivered' }))
      .mockResolvedValueOnce(barterRow({ status: 'completed' }));
    repo.transition.mockResolvedValue(true);
    vi.mocked(gamificationService.onContractCompleted).mockRejectedValueOnce(xp);
    vi.mocked(barterService.onLinkedContractCompleted).mockRejectedValueOnce(barter);
    const warn = vi.spyOn(logger, 'warn');

    const c = await contractsService.approve(1, 1);

    expect(c.status).toBe('completed');
    expect(warn).toHaveBeenCalledWith({ err: xp }, 'gamificação (onContractCompleted) falhou');
    expect(warn).toHaveBeenCalledWith({ err: barter }, 'troca (onLinkedContractCompleted) falhou');
    warn.mockRestore();
  });

  it('se a transição não pega (corrida), não há XP nem conclusão da troca', async () => {
    repo.findById.mockResolvedValue(barterRow({ status: 'delivered' }));
    repo.transition.mockResolvedValue(false);

    await expect(contractsService.approve(1, 1)).rejects.toMatchObject({ code: 'conflict' });

    expect(gamificationService.onContractCompleted).not.toHaveBeenCalled();
    expect(barterService.onLinkedContractCompleted).not.toHaveBeenCalled();
  });
});

describe('avisos', () => {
  it('se o envio do aviso falha, a transição já gravada vale e o erro só vai para o log', async () => {
    const boom = new Error('push fora do ar');
    repo.findById
      .mockResolvedValueOnce(fakeRow({ status: 'delivered' }))
      .mockResolvedValueOnce(fakeRow({ status: 'revision_requested' }));
    repo.transition.mockResolvedValue(true);
    vi.mocked(notificationsService.notify).mockRejectedValueOnce(boom);
    const warn = vi.spyOn(logger, 'warn');

    const c = await contractsService.requestRevision(1, 1, null);

    expect(c.status).toBe('revision_requested');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { err: boom, type: 'contract_revision' },
        'aviso de prazo falhou',
      ),
    );
    warn.mockRestore();
  });
});
