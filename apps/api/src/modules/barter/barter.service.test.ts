import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./barter.repository', () => ({
  barterRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    setStatusFromProposed: vi.fn(),
    accept: vi.fn(),
    completeAndRelease: vi.fn(),
    disputeAndRefund: vi.fn(),
  },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));

import { barterService } from './barter.service';
import { barterRepository, type BarterRow } from './barter.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';

const repo = vi.mocked(barterRepository);
const contracts = vi.mocked(contractsRepository);

type FakeBarterFields = Partial<{
  receiver_id: number;
  proposer_id: number;
  status: string;
  cash_payer_id: number | null;
  cash_difference: string;
  contract_offered_id: number | null;
  contract_requested_id: number | null;
}>;

function fakeBarter(o: FakeBarterFields = {}): BarterRow {
  return {
    id: 1,
    ulid: '01BARTER',
    proposer_id: 1,
    receiver_id: 2,
    offered_service_id: null,
    requested_service_id: null,
    offered_description: 'logo',
    requested_description: 'landing page',
    estimated_value_offered: '1000.00',
    estimated_value_requested: '800.00',
    cash_difference: '200.00',
    cash_payer_id: 2,
    platform_fee: '150.00',
    status: 'proposed',
    contract_offered_id: null,
    contract_requested_id: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  } as unknown as BarterRow;
}

const contractStatus = (status: string): ContractRow => ({ status }) as unknown as ContractRow;

beforeEach(() => vi.clearAllMocks());

describe('propose', () => {
  it('calcula torna, pagador e taxa de 15% sobre o maior valor (RN-066)', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    await barterService.propose(1, {
      receiverId: 2,
      offeredDescription: 'logo',
      requestedDescription: 'landing',
      estimatedValueOffered: 1000,
      estimatedValueRequested: 800,
    });
    const arg = repo.create.mock.calls[0]![0];
    expect(arg.cashDifference).toBe(200);
    expect(arg.cashPayerId).toBe(2); // ofertou mais (1000) -> receptor paga a diferença
    expect(arg.platformFee).toBe(150); // 15% de 1000
  });

  it('bloqueia troca consigo mesmo (400)', async () => {
    await expect(
      barterService.propose(5, {
        receiverId: 5,
        offeredDescription: 'x',
        requestedDescription: 'y',
        estimatedValueOffered: 100,
        estimatedValueRequested: 100,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('accept', () => {
  it('403 se não é o receptor', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ receiver_id: 2, status: 'proposed' }));
    await expect(barterService.accept(1, 99)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('409 se a troca não está mais proposta', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ receiver_id: 2, status: 'active' }));
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('gera os contratos recíprocos e ativa a troca (torna só registrada, sem mexer em carteira)', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeBarter({ receiver_id: 2, status: 'proposed' }))
      .mockResolvedValueOnce(
        fakeBarter({ receiver_id: 2, status: 'active', contract_offered_id: 10, contract_requested_id: 11 }),
      );
    repo.accept.mockResolvedValue({ contractOfferedId: 10, contractRequestedId: 11 });

    const b = await barterService.accept(1, 2);

    const arg = repo.accept.mock.calls[0]![0];
    expect(arg.contractOffered.freelancerId).toBe(1); // proponente entrega o oferecido
    expect(arg.contractRequested.freelancerId).toBe(2); // receptor entrega o solicitado
    expect(arg).not.toHaveProperty('torna'); // torna não é escrowada no aceite
    expect(b.status).toBe('active');
  });
});

describe('onLinkedContractCompleted', () => {
  it('conclui a troca e libera a torna quando os dois contratos estão completos', async () => {
    repo.findById.mockResolvedValue(
      fakeBarter({ status: 'active', contract_offered_id: 10, contract_requested_id: 11 }),
    );
    contracts.findById
      .mockResolvedValueOnce(contractStatus('completed'))
      .mockResolvedValueOnce(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);

    await barterService.onLinkedContractCompleted(1);

    expect(repo.completeAndRelease).toHaveBeenCalledWith(1);
  });

  it('não conclui se apenas um lado está completo', async () => {
    repo.findById.mockResolvedValue(
      fakeBarter({ status: 'active', contract_offered_id: 10, contract_requested_id: 11 }),
    );
    contracts.findById
      .mockResolvedValueOnce(contractStatus('completed'))
      .mockResolvedValueOnce(contractStatus('delivered'));

    await barterService.onLinkedContractCompleted(1);

    expect(repo.completeAndRelease).not.toHaveBeenCalled();
  });
});
