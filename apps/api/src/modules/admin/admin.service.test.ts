import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../disputes/disputes.repository', () => ({
  disputesRepository: { findById: vi.fn(), listOpen: vi.fn(), resolve: vi.fn() },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../contracts/milestones.repository', () => ({
  milestonesRepository: { escrowRemaining: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../auth/auth.repository', () => ({
  authRepository: { findByUlid: vi.fn().mockResolvedValue({ id: 5 }) },
}));
vi.mock('../auth/session.repository', () => ({
  sessionRepository: { revokeAllForUser: vi.fn().mockResolvedValue(0) },
}));
vi.mock('./admin.repository', () => ({
  adminRepository: { setUserStatus: vi.fn(), recordAction: vi.fn(), metrics: vi.fn() },
}));
// Só o aviso às partes é trocado; o resto do módulo é lido na carga de outros services.
vi.mock('../notifications/notifications.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notifications/notifications.service')>()),
  notificationsService: { notify: vi.fn() },
}));

import { adminService } from './admin.service';
import { disputesRepository, type DisputeRow } from '../disputes/disputes.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { adminRepository, type MetricsRow } from './admin.repository';
import { blocklist } from '../../config/blocklist';
import { authRepository } from '../auth/auth.repository';
import { sessionRepository } from '../auth/session.repository';
import { milestonesRepository } from '../contracts/milestones.repository';
import { notificationsService } from '../notifications/notifications.service';

const disputes = vi.mocked(disputesRepository);
const contracts = vi.mocked(contractsRepository);
const admin = vi.mocked(adminRepository);
const milestones = vi.mocked(milestonesRepository);
const users = vi.mocked(authRepository);
const sessions = vi.mocked(sessionRepository);
const notify = vi.mocked(notificationsService.notify);

const disputeRow = (o: Partial<{ status: string }> = {}): DisputeRow =>
  ({
    id: 1,
    ulid: '01DISPUTE',
    contract_id: 1,
    opened_by: 1,
    reason: 'quality',
    description: 'x',
    status: 'open',
    resolution: null,
    refund_percentage: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as DisputeRow;

const contractRow = (
  o: Partial<{ payment_mode: string; price: string; freelancer_net: string }> = {},
): ContractRow =>
  ({
    id: 1,
    client_id: 1,
    freelancer_id: 2,
    price: '1000.00',
    freelancer_net: '850.00',
    payment_mode: 'cash',
    ...o,
  }) as unknown as ContractRow;

beforeEach(() => {
  vi.clearAllMocks();
  disputes.findById.mockResolvedValue(disputeRow());
  contracts.findById.mockResolvedValue(contractRow());
  disputes.resolve.mockResolvedValue(true);
});

describe('adminService.resolveDispute (escrow)', () => {
  it('release_freelancer libera o líquido e conclui', async () => {
    await adminService.resolveDispute(10, 1, { resolution: 'release_freelancer' });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'cash',
        clientId: 1,
        escrowNet: 850,
        releaseToFreelancer: 850,
        refundToClient: 0,
        contractFinalStatus: 'completed',
      }),
    );
  });

  it('refund_client estorna tudo e cancela', async () => {
    await adminService.resolveDispute(10, 1, { resolution: 'refund_client' });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseToFreelancer: 0,
        refundToClient: 1000, // o preço inteiro, inclusive a taxa
        contractFinalStatus: 'cancelled',
        refundPercentage: 100,
      }),
    );
  });

  it('partial_split libera proporcional (40% reembolso -> 60% ao freelancer)', async () => {
    await adminService.resolveDispute(10, 1, { resolution: 'partial_split', refundPercentage: 40 });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseToFreelancer: 510,
        refundToClient: 400,
        contractFinalStatus: 'completed',
        refundPercentage: 40,
      }),
    );
  });

  it('em créditos divide os créditos retidos, sem sobra de arredondamento', async () => {
    contracts.findById.mockResolvedValue(
      contractRow({ payment_mode: 'credits', price: '45.00', freelancer_net: '45.00' }),
    );
    await adminService.resolveDispute(10, 1, { resolution: 'partial_split', refundPercentage: 50 });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'credits',
        escrowNet: 45,
        releaseToFreelancer: 23,
        refundToClient: 22,
      }),
    );
  });

  it('409 se já resolvida', async () => {
    disputes.findById.mockResolvedValue(disputeRow({ status: 'resolved' }));
    await expect(
      adminService.resolveDispute(10, 1, { resolution: 'release_freelancer' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'already_resolved',
    });
    expect(disputes.resolve).not.toHaveBeenCalled();
  });
});

describe('adminService.moderateUser', () => {
  it('bane o usuário e registra a ação', async () => {
    admin.setUserStatus.mockResolvedValue(true);
    admin.recordAction.mockResolvedValue(undefined);
    await adminService.moderateUser(10, '01HZXULIDEXAMPLE0000000000', 'ban');
    expect(admin.setUserStatus).toHaveBeenCalledTimes(1);
    expect(admin.setUserStatus).toHaveBeenCalledWith('01HZXULIDEXAMPLE0000000000', 'banned');
    expect(admin.recordAction).toHaveBeenCalledTimes(1);
    expect(admin.recordAction).toHaveBeenCalledWith(
      10,
      'user_ban',
      'user',
      null,
      'ulid=01HZXULIDEXAMPLE0000000000',
    );
  });

  it('404 quando o usuário não existe', async () => {
    admin.setUserStatus.mockResolvedValue(false);
    await expect(
      adminService.moderateUser(10, '01HZXULIDEXAMPLE0000000000', 'suspend'),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
    expect(admin.setUserStatus).toHaveBeenCalledWith('01HZXULIDEXAMPLE0000000000', 'suspended');
    expect(admin.recordAction).not.toHaveBeenCalled();
  });
});

/** Disputa 7 sobre a contratação 30, do cliente 11 com o freelancer 22: ids que não se confundem. */
const dispute7 = (o: Record<string, unknown> = {}): DisputeRow =>
  ({ ...disputeRow(), id: 7, contract_id: 30, opened_by: 11, ...o }) as unknown as DisputeRow;
const contract30 = (o: Record<string, unknown> = {}): ContractRow =>
  ({ ...contractRow(), id: 30, client_id: 11, freelancer_id: 22, ...o }) as unknown as ContractRow;

describe('adminService.listOpenDisputes', () => {
  it('devolve as disputas abertas no formato da API, na ordem em que vieram', async () => {
    disputes.listOpen.mockResolvedValue([
      dispute7(),
      dispute7({ id: 8, status: 'under_review', reason: 'deadline' }),
    ]);

    expect(await adminService.listOpenDisputes()).toEqual([
      {
        id: 7,
        ulid: '01DISPUTE',
        contractId: 30,
        openedBy: 11,
        reason: 'quality',
        description: 'x',
        status: 'open',
        resolution: null,
        refundPercentage: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 8,
        ulid: '01DISPUTE',
        contractId: 30,
        openedBy: 11,
        reason: 'deadline',
        description: 'x',
        status: 'under_review',
        resolution: null,
        refundPercentage: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(disputes.listOpen).toHaveBeenCalledTimes(1);
  });

  it('sem disputa aberta, lista vazia', async () => {
    disputes.listOpen.mockResolvedValue([]);
    expect(await adminService.listOpenDisputes()).toEqual([]);
  });
});

describe('adminService.resolveDispute (RN-063): o que é aplicado e quem é avisado', () => {
  beforeEach(() => {
    disputes.findById.mockResolvedValue(dispute7());
    contracts.findById.mockResolvedValue(contract30());
  });

  it('aplica a decisão sobre a contratação da disputa, com o admin, as partes e a nota (null quando não vem)', async () => {
    await adminService.resolveDispute(10, 7, { resolution: 'release_freelancer' });

    expect(disputes.findById).toHaveBeenCalledWith(7);
    expect(contracts.findById).toHaveBeenCalledWith(30);
    expect(milestones.escrowRemaining).toHaveBeenCalledWith(30);
    expect(disputes.resolve).toHaveBeenCalledTimes(1);
    expect(disputes.resolve).toHaveBeenCalledWith({
      disputeId: 7,
      adminId: 10,
      contractId: 30,
      freelancerId: 22,
      clientId: 11,
      paymentMode: 'cash',
      escrowNet: 850,
      releaseToFreelancer: 850,
      refundToClient: 0,
      contractFinalStatus: 'completed',
      resolution: 'release_freelancer',
      refundPercentage: 0,
      note: null,
    });

    await adminService.resolveDispute(10, 7, {
      resolution: 'refund_client',
      note: 'Nada foi entregue',
    });
    expect(disputes.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolution: 'refund_client', note: 'Nada foi entregue' }),
    );
  });

  it('disputa que não existe é 404, sem tocar em contratação nem em escrow', async () => {
    disputes.findById.mockResolvedValue(undefined);
    await expect(
      adminService.resolveDispute(10, 99, { resolution: 'refund_client' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'dispute_not_found' });
    expect(disputes.findById).toHaveBeenCalledWith(99);
    expect(contracts.findById).not.toHaveBeenCalled();
    expect(disputes.resolve).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('disputa já resolvida não mexe no escrow de novo', async () => {
    disputes.findById.mockResolvedValue(dispute7({ status: 'resolved' }));
    await expect(
      adminService.resolveDispute(10, 7, { resolution: 'refund_client' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'already_resolved' });
    expect(contracts.findById).not.toHaveBeenCalled();
    expect(disputes.resolve).not.toHaveBeenCalled();
  });

  it('contratação que não existe mais é 404 e nada é aplicado', async () => {
    contracts.findById.mockResolvedValue(undefined);
    await expect(
      adminService.resolveDispute(10, 7, { resolution: 'refund_client' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'contract_not_found' });
    expect(milestones.escrowRemaining).not.toHaveBeenCalled();
    expect(disputes.resolve).not.toHaveBeenCalled();
  });

  it('troca não tem escrow: nada é liberado nem devolvido, e os marcos nem são consultados', async () => {
    contracts.findById.mockResolvedValue(contract30({ payment_mode: 'barter' }));

    await adminService.resolveDispute(10, 7, { resolution: 'refund_client' });

    expect(milestones.escrowRemaining).not.toHaveBeenCalled();
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'barter',
        escrowNet: 0,
        releaseToFreelancer: 0,
        refundToClient: 0,
        contractFinalStatus: 'cancelled',
        refundPercentage: 100,
      }),
    );
  });

  it('contratação sem modo de pagamento gravado é tratada como dinheiro', async () => {
    contracts.findById.mockResolvedValue(contract30({ payment_mode: null }));
    await adminService.resolveDispute(10, 7, { resolution: 'refund_client' });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: 'cash', escrowNet: 850, refundToClient: 1000 }),
    );
  });

  it('por marcos, a divisão é só sobre o que ainda não foi liberado', async () => {
    // Contrato de 1000 (líquido 850) com 400 (líquido 340) ainda retidos.
    milestones.escrowRemaining.mockResolvedValueOnce({ price: 400, net: 340 });

    await adminService.resolveDispute(10, 7, { resolution: 'partial_split', refundPercentage: 50 });

    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowNet: 340,
        refundToClient: 200, // metade do preço retido
        releaseToFreelancer: 170, // metade do líquido retido
        refundPercentage: 50,
      }),
    );
  });

  it('em créditos por marcos, o retido é arredondado para créditos inteiros antes de dividir', async () => {
    contracts.findById.mockResolvedValue(
      contract30({ payment_mode: 'credits', price: '45.00', freelancer_net: '45.00' }),
    );
    milestones.escrowRemaining.mockResolvedValueOnce({ price: 29.6, net: 29.6 });

    await adminService.resolveDispute(10, 7, { resolution: 'partial_split', refundPercentage: 25 });

    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'credits',
        escrowNet: 30,
        releaseToFreelancer: 23, // 75% de 30 = 22,5, arredondado
        refundToClient: 7, // o que sobra: os dois somam o retido
      }),
    );
  });

  it('liberação total e reembolso total não olham a porcentagem que vier junto: valem 0% e 100%', async () => {
    await adminService.resolveDispute(10, 7, {
      resolution: 'release_freelancer',
      refundPercentage: 70,
    });
    expect(disputes.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: 'release_freelancer',
        refundPercentage: 0,
        releaseToFreelancer: 850,
        refundToClient: 0,
        contractFinalStatus: 'completed',
      }),
    );

    await adminService.resolveDispute(10, 7, { resolution: 'refund_client', refundPercentage: 30 });
    expect(disputes.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: 'refund_client',
        refundPercentage: 100,
        releaseToFreelancer: 0,
        refundToClient: 1000,
        contractFinalStatus: 'cancelled',
      }),
    );
  });

  it('em créditos, liberar tudo ou devolver tudo move o retido inteiro para um lado só', async () => {
    contracts.findById.mockResolvedValue(
      contract30({ payment_mode: 'credits', price: '45.00', freelancer_net: '45.00' }),
    );

    await adminService.resolveDispute(10, 7, { resolution: 'release_freelancer' });
    expect(disputes.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paymentMode: 'credits',
        escrowNet: 45,
        releaseToFreelancer: 45,
        refundToClient: 0,
        contractFinalStatus: 'completed',
      }),
    );

    await adminService.resolveDispute(10, 7, { resolution: 'refund_client' });
    expect(disputes.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paymentMode: 'credits',
        escrowNet: 45,
        releaseToFreelancer: 0,
        refundToClient: 45,
        contractFinalStatus: 'cancelled',
      }),
    );
  });

  it('divisão sem porcentagem não devolve nada ao cliente', async () => {
    await adminService.resolveDispute(10, 7, { resolution: 'partial_split' });
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        refundPercentage: 0,
        releaseToFreelancer: 850,
        refundToClient: 0,
        contractFinalStatus: 'completed',
      }),
    );
  });

  it('divisão com 100% devolve o preço inteiro ao cliente e não libera nada ao freelancer', async () => {
    await adminService.resolveDispute(10, 7, {
      resolution: 'partial_split',
      refundPercentage: 100,
    });
    // Só o dinheiro: o status final da contratação neste caso é ponto em aberto (ver o retorno da revisão).
    expect(disputes.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: 'partial_split',
        refundPercentage: 100,
        escrowNet: 850,
        releaseToFreelancer: 0,
        refundToClient: 1000,
      }),
    );
  });

  it('falha ao aplicar a decisão sobe para quem chamou: ninguém é avisado e a disputa não é relida', async () => {
    const boom = new Error('ER_LOCK_DEADLOCK');
    disputes.resolve.mockRejectedValueOnce(boom);

    await expect(adminService.resolveDispute(10, 7, { resolution: 'refund_client' })).rejects.toBe(
      boom,
    );

    expect(notify).not.toHaveBeenCalled();
    expect(disputes.findById).toHaveBeenCalledTimes(1);
  });

  it('se a decisão não pôde ser aplicada (corrida ou carteira sem saldo) é 409 e ninguém é avisado', async () => {
    disputes.resolve.mockResolvedValue(false);
    await expect(
      adminService.resolveDispute(10, 7, { resolution: 'release_freelancer' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'conflict' });
    expect(notify).not.toHaveBeenCalled();
    // Só a leitura inicial: não relê uma disputa que não foi resolvida.
    expect(disputes.findById).toHaveBeenCalledTimes(1);
  });

  it('avisa o cliente e o freelancer do desfecho e devolve a disputa relida depois de aplicar', async () => {
    disputes.findById
      .mockResolvedValueOnce(dispute7())
      .mockResolvedValueOnce(
        dispute7({ status: 'resolved', resolution: 'partial_split', refund_percentage: 40 }),
      );

    const out = await adminService.resolveDispute(10, 7, {
      resolution: 'partial_split',
      refundPercentage: 40,
    });

    expect(out).toMatchObject({
      id: 7,
      contractId: 30,
      status: 'resolved',
      resolution: 'partial_split',
      refundPercentage: 40,
    });
    expect(disputes.findById).toHaveBeenCalledTimes(2);
    const notice = {
      type: 'dispute_resolved',
      title: 'Disputa resolvida pela mediação',
      body: 'Divisão: 40% devolvido ao cliente, o restante liberado ao freelancer.',
      data: { contractId: 30, disputeId: 7 },
    };
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, 11, notice);
    expect(notify).toHaveBeenNthCalledWith(2, 22, notice);
  });

  it('o aviso diz para onde foi o valor: liberado ao freelancer ou devolvido ao cliente', async () => {
    await adminService.resolveDispute(10, 7, { resolution: 'release_freelancer' });
    expect(notify).toHaveBeenLastCalledWith(
      22,
      expect.objectContaining({ body: 'Valor do escrow liberado ao freelancer.' }),
    );

    await adminService.resolveDispute(10, 7, { resolution: 'refund_client' });
    expect(notify).toHaveBeenLastCalledWith(
      22,
      expect.objectContaining({ body: 'Valor do escrow devolvido ao cliente.' }),
    );
    expect(notify).toHaveBeenCalledTimes(4);
  });
});

describe('adminService.moderateUser (RN-007): efeito imediato', () => {
  const ULID = '01HZXULIDEXAMPLE0000000000';
  // O usuário moderado é o 5 (o que o authRepository mockado devolve pelo ulid).
  const USER_ID = 5;

  beforeEach(() => {
    blocklist.delete(USER_ID);
    admin.setUserStatus.mockResolvedValue(true);
    admin.recordAction.mockResolvedValue(undefined);
  });

  it('suspender e banir: mudam o status, bloqueiam o token vigente, derrubam as sessões e registram a ação', async () => {
    const expected = [
      ['suspend', 'suspended'],
      ['ban', 'banned'],
    ] as const;
    for (const [action, status] of expected) {
      vi.clearAllMocks();
      blocklist.delete(USER_ID);

      await adminService.moderateUser(10, ULID, action);

      expect(admin.setUserStatus).toHaveBeenCalledWith(ULID, status);
      expect(users.findByUlid).toHaveBeenCalledWith(ULID);
      expect(blocklist.has(USER_ID)).toBe(true);
      expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
      expect(admin.recordAction).toHaveBeenCalledTimes(1);
      expect(admin.recordAction).toHaveBeenCalledWith(
        10,
        `user_${action}`,
        'user',
        null,
        `ulid=${ULID}`,
      );
    }
  });

  it('reativar: volta para active, sai da lista de bloqueio e não mexe nas sessões', async () => {
    blocklist.add(USER_ID);

    await adminService.moderateUser(10, ULID, 'reactivate');

    expect(admin.setUserStatus).toHaveBeenCalledWith(ULID, 'active');
    expect(blocklist.has(USER_ID)).toBe(false);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(admin.recordAction).toHaveBeenCalledWith(
      10,
      'user_reactivate',
      'user',
      null,
      `ulid=${ULID}`,
    );
  });

  it('se derrubar as sessões falha, o erro sobe, mas o token vigente já está barrado', async () => {
    const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
    sessions.revokeAllForUser.mockRejectedValueOnce(boom);

    await expect(adminService.moderateUser(10, ULID, 'ban')).rejects.toBe(boom);

    // O bloqueio em memória vem antes de derrubar as sessões no banco.
    expect(blocklist.has(USER_ID)).toBe(true);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('usuário que não existe: 404, ninguém é bloqueado e nada é registrado', async () => {
    admin.setUserStatus.mockResolvedValue(false);
    await expect(adminService.moderateUser(10, ULID, 'ban')).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
    expect(users.findByUlid).not.toHaveBeenCalled();
    expect(blocklist.has(USER_ID)).toBe(false);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(admin.recordAction).not.toHaveBeenCalled();
  });

  it('se o usuário some entre a mudança e a releitura, a ação fica registrada sem bloquear ninguém', async () => {
    users.findByUlid.mockResolvedValueOnce(undefined);
    const before = blocklist.size();

    await adminService.moderateUser(10, ULID, 'suspend');

    expect(blocklist.size()).toBe(before);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(admin.recordAction).toHaveBeenCalledWith(
      10,
      'user_suspend',
      'user',
      null,
      `ulid=${ULID}`,
    );
  });
});

describe('adminService.getMetrics', () => {
  it('traduz a linha do banco para o resumo do painel, com os decimais em número', async () => {
    admin.metrics.mockResolvedValue({
      users: 12,
      freelancers: 5,
      contracts: 9,
      completed_contracts: 4,
      open_disputes: 1,
      platform_fees: '150.50',
      in_escrow: '850.00',
      pending_withdrawals: '2',
      pending_withdrawals_amount: '300.00',
      deposits_total: '2000.00',
      users_balance: '700.25',
      pending_deletions: '3',
    } as unknown as MetricsRow);

    expect(await adminService.getMetrics()).toEqual({
      users: 12,
      freelancers: 5,
      contracts: 9,
      completedContracts: 4,
      openDisputes: 1,
      platformFees: 150.5,
      inEscrow: 850,
      pendingWithdrawals: 2,
      pendingWithdrawalsAmount: 300,
      depositsTotal: 2000,
      usersBalance: 700.25,
      pendingDeletions: 3,
    });
    expect(admin.metrics).toHaveBeenCalledTimes(1);
  });
});
