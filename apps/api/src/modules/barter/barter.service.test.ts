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
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { barterService } from './barter.service';
import { barterRepository, type BarterRow } from './barter.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';

const repo = vi.mocked(barterRepository);
const contracts = vi.mocked(contractsRepository);
const notify = vi.mocked(notificationsService.notify);

type FakeBarterFields = Partial<{
  receiver_id: number;
  proposer_id: number;
  status: string;
  cash_payer_id: number | null;
  cash_difference: string;
  platform_fee: string;
  torna_status: string;
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
    platform_fee: '30.00',
    torna_status: 'pending',
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
  it('receptor paga a torna: taxa de 15% só sobre a torna, reserva fica pendente até o aceite', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    const b = await barterService.propose(1, {
      receiverId: 2,
      offeredDescription: 'logo',
      requestedDescription: 'landing page',
      estimatedValueOffered: 1000,
      estimatedValueRequested: 800,
    });
    const [data, hold] = repo.create.mock.calls[0]!;
    expect(data).toMatchObject({
      cashDifference: 200,
      cashPayerId: 2,
      platformFee: 30,
      tornaStatus: 'pending',
    });
    expect(hold).toBeNull();
    expect(b.tornaNet).toBe(170);
  });

  it('proponente paga a torna: reserva na carteira dele já na proposta', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter({ cash_payer_id: 1, torna_status: 'held' }));
    await barterService.propose(1, {
      receiverId: 2,
      offeredDescription: 'logo',
      requestedDescription: 'landing page',
      estimatedValueOffered: 600,
      estimatedValueRequested: 800,
    });
    const [data, hold] = repo.create.mock.calls[0]!;
    expect(data).toMatchObject({ cashDifference: 200, cashPayerId: 1, tornaStatus: 'none' });
    expect(hold).toEqual({ userId: 1, amount: 200 });
  });

  it('402 quando o proponente paga a torna e não tem saldo', async () => {
    repo.create.mockResolvedValue(null);
    await expect(
      barterService.propose(1, {
        receiverId: 2,
        offeredDescription: 'logo',
        requestedDescription: 'landing page',
        estimatedValueOffered: 600,
        estimatedValueRequested: 800,
      }),
    ).rejects.toMatchObject({ statusCode: 402, code: 'insufficient_balance' });
  });

  it('troca equilibrada: sem torna, sem taxa, sem reserva', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(
      fakeBarter({
        cash_difference: '0.00',
        cash_payer_id: null,
        platform_fee: '0.00',
        torna_status: 'none',
      }),
    );
    await barterService.propose(1, {
      receiverId: 2,
      offeredDescription: 'a',
      requestedDescription: 'b',
      estimatedValueOffered: 500,
      estimatedValueRequested: 500,
    });
    const [data, hold] = repo.create.mock.calls[0]!;
    expect(data).toMatchObject({
      cashDifference: 0,
      cashPayerId: null,
      platformFee: 0,
      tornaStatus: 'none',
    });
    expect(hold).toBeNull();
  });

  it('bloqueia troca consigo mesmo (400)', async () => {
    await expect(
      barterService.propose(5, {
        receiverId: 5,
        offeredDescription: 'x',
        requestedDescription: 'y',
        estimatedValueOffered: 1,
        estimatedValueRequested: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.create).not.toHaveBeenCalled();
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

  it('gera os contratos recíprocos e reserva a torna do receptor (pendente) no aceite', async () => {
    repo.findById
      .mockResolvedValueOnce(
        fakeBarter({ receiver_id: 2, status: 'proposed', torna_status: 'pending' }),
      )
      .mockResolvedValueOnce(
        fakeBarter({
          receiver_id: 2,
          status: 'active',
          torna_status: 'held',
          contract_offered_id: 10,
          contract_requested_id: 11,
        }),
      );
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });

    const b = await barterService.accept(1, 2);

    const arg = repo.accept.mock.calls[0]![0];
    expect(arg.contractOffered.freelancerId).toBe(1); // proponente entrega o oferecido
    expect(arg.contractRequested.freelancerId).toBe(2); // receptor entrega o solicitado
    expect(arg.hold).toEqual({ userId: 2, amount: 200 });
    expect(b.status).toBe('active');
    expect(b.tornaStatus).toBe('held');
  });

  it('torna já reservada pelo proponente: aceite não reserva de novo', async () => {
    repo.findById
      .mockResolvedValueOnce(fakeBarter({ cash_payer_id: 1, torna_status: 'held' }))
      .mockResolvedValueOnce(
        fakeBarter({ cash_payer_id: 1, torna_status: 'held', status: 'active' }),
      );
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });
    await barterService.accept(1, 2);
    expect(repo.accept.mock.calls[0]![0].hold).toBeNull();
  });

  it('402 quando o receptor paga a torna e não tem saldo; 409 em corrida', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    repo.accept.mockResolvedValueOnce({ ok: false, reason: 'insufficient_balance' });
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 402,
      code: 'insufficient_balance',
    });
    repo.accept.mockResolvedValueOnce({ ok: false, reason: 'conflict' });
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('onLinkedContractCompleted', () => {
  it('conclui a troca, liquida a torna e avisa os dois lados quando ambos os contratos completam', async () => {
    repo.findById.mockResolvedValue(
      fakeBarter({
        status: 'active',
        torna_status: 'held',
        contract_offered_id: 10,
        contract_requested_id: 11,
      }),
    );
    contracts.findById
      .mockResolvedValueOnce(contractStatus('completed'))
      .mockResolvedValueOnce(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);

    await barterService.onLinkedContractCompleted(1);

    expect(repo.completeAndRelease).toHaveBeenCalledWith(1);
    // pagador (2) e quem recebe a torna (1) recebem mensagens diferentes
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: 'barter_completed',
        body: expect.stringMatching(/R\$\s170,00/),
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'barter_completed',
        body: expect.stringContaining('paga ao outro lado'),
      }),
    );
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
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('onLinkedContractCancelled', () => {
  it('troca entra em disputa, torna reservada volta e as partes são avisadas', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active', torna_status: 'held' }));
    repo.disputeAndRefund.mockResolvedValue(true);
    await barterService.onLinkedContractCancelled(1);
    expect(repo.disputeAndRefund).toHaveBeenCalledWith(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'barter_disputed', body: expect.stringContaining('voltou') }),
    );
  });
});
