import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { contractsService } from './contracts.service';
import { contractsRepository, type ContractRow, type HistoryRow } from './contracts.repository';

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
  deadline_at: Date | null;
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
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.platformFee).toBe(150);
    expect(arg.freelancerNet).toBe(850);
    expect(contract.status).toBe('pending');
  });

  it('bloqueia auto-contratação (400)', async () => {
    await expect(
      contractsService.create(5, {
        freelancerId: 5,
        title: 'X qualquer',
        description: 'descrição bem longa aqui',
        price: 100,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('accept', () => {
  it('403 se não for o freelancer', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'pending' }));
    await expect(contractsService.accept(1, 99)).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('409 se status não for pending', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'accepted' }));
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({ statusCode: 409 });
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
        // escrow financiado: líquido (850) entra no pendente do freelancer
        walletEffect: { userId: 2, pendingDelta: 850, balanceDelta: 0 },
      }),
    );
    expect(c.status).toBe('accepted');
  });

  it('409 em corrida (transition retorna false)', async () => {
    repo.findById.mockResolvedValue(fakeRow({ freelancer_id: 2, status: 'pending' }));
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.accept(1, 2)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('approve', () => {
  it('403 se não for o cliente', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'delivered' }));
    await expect(contractsService.approve(1, 2)).rejects.toMatchObject({ statusCode: 403 });
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
        walletEffect: { userId: 2, pendingDelta: -850, balanceDelta: 850 },
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
    });
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
    expect(repo.deliver).toHaveBeenCalledOnce();
    expect(c.status).toBe('delivered');
  });
});

describe('cancel (RN-025)', () => {
  it('reembolso 100% em pending', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'pending' }));
    repo.transition.mockResolvedValue(true);
    const r = await contractsService.cancel(1, 1);
    expect(r.refundPercentage).toBe(100);
    expect(r.status).toBe('cancelled');
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
  });

  it('409 ao cancelar após a entrega', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, status: 'delivered' }));
    await expect(contractsService.cancel(1, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('getById', () => {
  it('403 se não participa', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, freelancer_id: 2 }));
    await expect(contractsService.getById(1, 99)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('retorna contrato com histórico', async () => {
    repo.findById.mockResolvedValue(fakeRow({ client_id: 1, freelancer_id: 2, status: 'pending' }));
    repo.listHistory.mockResolvedValue([
      { old_status: null, new_status: 'pending', note: 'Proposta enviada', created_at: new Date('2026-01-01T00:00:00Z') },
    ] as unknown as HistoryRow[]);
    const c = await contractsService.getById(1, 1);
    expect(c.history).toHaveLength(1);
    expect(c.history[0]!.status).toBe('pending');
    expect(c.history[0]!.previousStatus).toBeNull();
  });
});
