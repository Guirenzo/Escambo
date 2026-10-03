import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: {
    feeRate: vi.fn().mockResolvedValue(0.15),
    barterEnabled: vi.fn().mockResolvedValue(true),
  },
}));

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
import { settingsService } from '../settings/settings.service';

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

/**
 * Regras do service que os casos acima não tocam: trocas desligadas, taxa vigente, formato
 * devolvido à API, quem pode ver, recusar e cancelar, e as saídas antecipadas dos ganchos.
 */
const settings = vi.mocked(settingsService);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const proposal = {
  receiverId: 2,
  offeredDescription: 'logo',
  requestedDescription: 'landing page',
  estimatedValueOffered: 1000,
  estimatedValueRequested: 800,
};

/** O acordo padrão de `fakeBarter()` no formato que a API devolve. */
const barterDto = {
  id: 1,
  ulid: '01BARTER',
  proposerId: 1,
  receiverId: 2,
  offeredServiceId: null,
  requestedServiceId: null,
  offeredServiceTitle: null,
  requestedServiceTitle: null,
  offeredDescription: 'logo',
  requestedDescription: 'landing page',
  estimatedValueOffered: 1000,
  estimatedValueRequested: 800,
  cashDifference: 200,
  cashPayerId: 2,
  platformFee: 30,
  tornaNet: 170,
  tornaStatus: 'pending',
  status: 'proposed',
  contractOfferedId: null,
  contractRequestedId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('propose: configurações e o que é gravado', () => {
  it('com as trocas desligadas nas configurações é 403 barter_disabled e nada é criado', async () => {
    settings.barterEnabled.mockResolvedValueOnce(false);
    await expect(barterService.propose(1, proposal)).rejects.toMatchObject({
      statusCode: 403,
      code: 'barter_disabled',
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('troca consigo mesmo tem o código self_barter', async () => {
    await expect(barterService.propose(2, proposal)).rejects.toMatchObject({
      statusCode: 400,
      code: 'self_barter',
    });
  });

  it('a taxa sobre a torna é a vigente nas configurações (ADR 32), não os 15% fixos', async () => {
    settings.feeRate.mockResolvedValueOnce(0.1);
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    await barterService.propose(1, proposal);
    expect(repo.create.mock.calls[0]![0]).toMatchObject({ cashDifference: 200, platformFee: 20 });
  });

  it('torna e taxa são arredondadas em centavos, meio centavo para cima', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    // 1.1 − 1.0 dá 0.10000000000000009 no ponto flutuante; 15% de 0,10 é 0,015 → 0,02.
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 1.1,
      estimatedValueRequested: 1,
    });
    const [data] = repo.create.mock.calls[0]!;
    expect(data.cashDifference).toBe(0.1);
    expect(data.platformFee).toBe(0.02);
  });

  it('grava a proposta em nome do proponente, com ulid novo e nulo no que não veio', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());

    await barterService.propose(1, { ...proposal, offeredServiceId: 31 });

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      {
        ulid: expect.stringMatching(ULID),
        proposerId: 1,
        receiverId: 2,
        offeredServiceId: 31,
        requestedServiceId: null,
        offeredDescription: 'logo',
        requestedDescription: 'landing page',
        estimatedValueOffered: 1000,
        estimatedValueRequested: 800,
        cashDifference: 200,
        cashPayerId: 2,
        platformFee: 30,
        tornaStatus: 'pending',
      },
      null,
    );

    // Sem descrição (só serviço do catálogo), a descrição vai nula.
    await barterService.propose(1, {
      receiverId: 2,
      offeredServiceId: 31,
      requestedServiceId: 32,
      estimatedValueOffered: 500,
      estimatedValueRequested: 500,
    });
    expect(repo.create.mock.calls[1]![0]).toMatchObject({
      offeredServiceId: 31,
      requestedServiceId: 32,
      offeredDescription: null,
      requestedDescription: null,
    });
  });

  it('devolve o acordo recém-criado, lido pelo id que o repository gerou, no formato da API', async () => {
    repo.create.mockResolvedValue(42);
    repo.findById.mockResolvedValue(fakeBarter());
    expect(await barterService.propose(1, proposal)).toEqual(barterDto);
    expect(repo.findById).toHaveBeenCalledWith(42);
  });

  it('sem saldo para a torna, a mensagem diz o valor e pede um depósito', async () => {
    repo.create.mockResolvedValue(null);
    await expect(
      barterService.propose(1, {
        ...proposal,
        estimatedValueOffered: 600,
        estimatedValueRequested: 800,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Saldo insuficiente para reservar a torna de R\$\s200,00\. Faça um depósito/,
      ),
    });
    expect(repo.findById).not.toHaveBeenCalled();
  });
});

describe('listMine', () => {
  it('pede ao repository a página de quem está logado e devolve os acordos no formato da API', async () => {
    repo.listForUser.mockResolvedValue([fakeBarter()]);
    expect(await barterService.listMine(7, { page: 3, limit: 10 })).toEqual({
      items: [barterDto],
      page: 3,
      limit: 10,
    });
    // Página 3 de 10 em 10: pula 20.
    expect(repo.listForUser).toHaveBeenCalledWith(7, 10, 20);
  });

  it('a primeira página não pula nada', async () => {
    repo.listForUser.mockResolvedValue([]);
    expect(await barterService.listMine(7, { page: 1, limit: 20 })).toEqual({
      items: [],
      page: 1,
      limit: 20,
    });
    expect(repo.listForUser).toHaveBeenCalledWith(7, 20, 0);
  });
});

describe('getById', () => {
  it('troca inexistente é 404 barter_not_found', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(barterService.getById(9, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'barter_not_found',
    });
    expect(repo.findById).toHaveBeenCalledWith(9);
  });

  it('só quem participa da troca pode ver: terceiro recebe 403', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    await expect(barterService.getById(1, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
  });

  it('proponente e receptor veem o acordo, com os títulos dos serviços e os valores em número', async () => {
    const row = {
      ...fakeBarter({ cash_payer_id: 1, torna_status: 'held', status: 'active' }),
      offered_service_id: 31,
      requested_service_id: 32,
      offered_title: 'Logo',
      requested_title: 'Site',
      contract_offered_id: 10,
      contract_requested_id: 11,
    } as BarterRow;
    repo.findById.mockResolvedValue(row);
    const expected = {
      ...barterDto,
      offeredServiceId: 31,
      requestedServiceId: 32,
      offeredServiceTitle: 'Logo',
      requestedServiceTitle: 'Site',
      cashPayerId: 1,
      tornaStatus: 'held',
      status: 'active',
      contractOfferedId: 10,
      contractRequestedId: 11,
    };
    expect(await barterService.getById(1, 1)).toEqual(expected);
    expect(await barterService.getById(1, 2)).toEqual(expected);
  });

  it('o líquido da torna nunca é negativo, e acordo antigo sem torna_status sai como none', async () => {
    const row = {
      ...fakeBarter({ cash_difference: '10.00', platform_fee: '15.00' }),
      torna_status: null,
    } as unknown as BarterRow;
    repo.findById.mockResolvedValue(row);
    const b = await barterService.getById(1, 1);
    expect(b.tornaNet).toBe(0);
    expect(b.tornaStatus).toBe('none');
  });
});

describe('accept: o que vai para o repository e as recusas', () => {
  it('troca inexistente é 404 e nada é aceito', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 404,
      code: 'barter_not_found',
    });
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it('o proponente não aceita a própria proposta, e troca fora de proposed diz o estado atual', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    await expect(barterService.accept(1, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });

    repo.findById.mockResolvedValue(fakeBarter({ status: 'cancelled' }));
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_status',
      message: 'Troca não está mais disponível (cancelled)',
    });
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it('os dois contratos são recíprocos: cada parte é cliente de um e freelancer do outro (RN-067)', async () => {
    const row = {
      ...fakeBarter(),
      offered_service_id: 31,
      requested_service_id: null,
    } as BarterRow;
    repo.findById.mockResolvedValue(row);
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });

    await barterService.accept(1, 2);

    expect(repo.accept).toHaveBeenCalledTimes(1);
    expect(repo.accept).toHaveBeenCalledWith({
      agreementId: 1,
      acceptorId: 2,
      contractOffered: {
        ulid: expect.stringMatching(ULID),
        clientId: 2,
        freelancerId: 1,
        serviceId: 31,
        title: 'Troca — entrega do proponente',
        description: 'logo',
        price: 1000,
      },
      contractRequested: {
        ulid: expect.stringMatching(ULID),
        clientId: 1,
        freelancerId: 2,
        serviceId: null,
        title: 'Troca — entrega do receptor',
        description: 'landing page',
        price: 800,
      },
      hold: { userId: 2, amount: 200 },
    });
    const arg = repo.accept.mock.calls[0]![0];
    expect(arg.contractOffered.ulid).not.toBe(arg.contractRequested.ulid);
    // Depois do aceite, o acordo é relido para devolver o estado novo.
    expect(repo.findById).toHaveBeenCalledTimes(2);
  });

  it('troca só por serviço do catálogo (sem descrição) gera contratos com a descrição padrão', async () => {
    const row = {
      ...fakeBarter(),
      offered_description: null,
      requested_description: null,
    } as BarterRow;
    repo.findById.mockResolvedValue(row);
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });

    await barterService.accept(1, 2);

    const arg = repo.accept.mock.calls[0]![0];
    expect(arg.contractOffered.description).toBe('Serviço oferecido na troca');
    expect(arg.contractRequested.description).toBe('Serviço solicitado na troca');
  });

  it('troca equilibrada não reserva nada no aceite, mesmo marcada como pendente', async () => {
    repo.findById.mockResolvedValue(
      fakeBarter({ cash_difference: '0.00', cash_payer_id: null, torna_status: 'none' }),
    );
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });
    await barterService.accept(1, 2);
    expect(repo.accept.mock.calls[0]![0].hold).toBeNull();

    repo.findById.mockResolvedValue(
      fakeBarter({ cash_difference: '0.00', cash_payer_id: 2, torna_status: 'pending' }),
    );
    await barterService.accept(1, 2);
    expect(repo.accept.mock.calls[1]![0].hold).toBeNull();
  });

  it('sem saldo: a mensagem fala com quem aceita quando é ele quem paga, e do proponente quando é o outro', async () => {
    // Receptor paga a torna e é quem está aceitando.
    repo.findById.mockResolvedValue(fakeBarter({ cash_payer_id: 2, torna_status: 'pending' }));
    repo.accept.mockResolvedValue({ ok: false, reason: 'insufficient_balance' });
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 402,
      message: expect.stringMatching(
        /^Saldo insuficiente para reservar a torna de R\$\s200,00\. Faça um depósito/,
      ),
    });

    // Acordo antigo: o proponente paga e a torna ainda não foi reservada.
    repo.findById.mockResolvedValue(fakeBarter({ cash_payer_id: 1, torna_status: 'pending' }));
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 402,
      code: 'insufficient_balance',
      message: expect.stringMatching(
        /^O proponente ainda não tem saldo para reservar a torna de R\$\s200,00\.$/,
      ),
    });
    expect(repo.accept.mock.calls[1]![0].hold).toEqual({ userId: 1, amount: 200 });
  });

  it('aceite em corrida tem o código conflict e não relê o acordo', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    repo.accept.mockResolvedValue({ ok: false, reason: 'conflict' });
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });
});

describe('reject', () => {
  it('troca inexistente é 404', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(barterService.reject(1, 2)).rejects.toMatchObject({
      statusCode: 404,
      code: 'barter_not_found',
    });
    expect(repo.setStatusFromProposed).not.toHaveBeenCalled();
  });

  it('só quem recebeu a proposta pode recusar: o proponente e um terceiro recebem 403', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    for (const uid of [1, 99]) {
      await expect(barterService.reject(1, uid)).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
        message: 'Apenas quem recebeu a proposta pode recusar',
      });
    }
    expect(repo.setStatusFromProposed).not.toHaveBeenCalled();
  });

  it('o receptor recusa: a troca vai para rejected', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    repo.setStatusFromProposed.mockResolvedValue(true);
    await expect(barterService.reject(1, 2)).resolves.toBeUndefined();
    expect(repo.setStatusFromProposed).toHaveBeenCalledTimes(1);
    expect(repo.setStatusFromProposed).toHaveBeenCalledWith(1, 'rejected');
  });

  it('troca que já saiu de proposed é 409 invalid_status, com o estado na mensagem', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active' }));
    repo.setStatusFromProposed.mockResolvedValue(false);
    await expect(barterService.reject(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_status',
      message: 'Troca não está mais disponível (active)',
    });
  });
});

describe('cancel', () => {
  it('troca inexistente é 404', async () => {
    repo.findById.mockResolvedValue(undefined);
    await expect(barterService.cancel(1, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'barter_not_found',
    });
    expect(repo.setStatusFromProposed).not.toHaveBeenCalled();
  });

  it('quem não participa da troca não cancela (403)', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    await expect(barterService.cancel(1, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Você não participa desta troca',
    });
    expect(repo.setStatusFromProposed).not.toHaveBeenCalled();
  });

  it('proponente ou receptor cancelam: a troca vai para cancelled', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    repo.setStatusFromProposed.mockResolvedValue(true);
    await expect(barterService.cancel(1, 1)).resolves.toBeUndefined();
    await expect(barterService.cancel(1, 2)).resolves.toBeUndefined();
    expect(repo.setStatusFromProposed.mock.calls).toEqual([
      [1, 'cancelled'],
      [1, 'cancelled'],
    ]);
  });

  it('só dá para cancelar troca ainda proposta: senão 409 invalid_status', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active' }));
    repo.setStatusFromProposed.mockResolvedValue(false);
    await expect(barterService.cancel(1, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_status',
      message: 'Só é possível cancelar uma troca ainda proposta',
    });
  });
});

describe('onLinkedContractCompleted: quando não conclui e o que avisa', () => {
  const active = (o: FakeBarterFields = {}): BarterRow =>
    fakeBarter({
      status: 'active',
      torna_status: 'held',
      contract_offered_id: 10,
      contract_requested_id: 11,
      ...o,
    });

  it('troca inexistente, fora de active ou sem os dois contratos: não consulta contrato nem conclui', async () => {
    for (const row of [
      undefined,
      active({ status: 'completed' }),
      active({ status: 'disputed' }),
      active({ contract_offered_id: null }),
      active({ contract_requested_id: null }),
    ]) {
      repo.findById.mockResolvedValue(row);
      await barterService.onLinkedContractCompleted(1);
    }
    expect(contracts.findById).not.toHaveBeenCalled();
    expect(repo.completeAndRelease).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('consulta os dois contratos do acordo; se o do proponente ainda não concluiu, espera', async () => {
    repo.findById.mockResolvedValue(active());
    contracts.findById
      .mockResolvedValueOnce(contractStatus('in_progress'))
      .mockResolvedValueOnce(contractStatus('completed'));

    await barterService.onLinkedContractCompleted(1);

    expect(contracts.findById.mock.calls).toEqual([[10], [11]]);
    expect(repo.completeAndRelease).not.toHaveBeenCalled();
  });

  it('contrato que sumiu conta como não concluído', async () => {
    repo.findById.mockResolvedValue(active());
    contracts.findById
      .mockResolvedValueOnce(contractStatus('completed'))
      .mockResolvedValueOnce(undefined);
    await barterService.onLinkedContractCompleted(1);
    expect(repo.completeAndRelease).not.toHaveBeenCalled();
  });

  it('se outra requisição já concluiu a troca (repository devolve false), ninguém é avisado de novo', async () => {
    repo.findById.mockResolvedValue(active());
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(false);

    await barterService.onLinkedContractCompleted(1);

    expect(repo.completeAndRelease).toHaveBeenCalledWith(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('proponente pagou a torna: o receptor é avisado do crédito líquido e da taxa, o proponente do pagamento', async () => {
    repo.findById.mockResolvedValue(active({ cash_payer_id: 1 }));
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);

    await barterService.onLinkedContractCompleted(7);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(1, {
      type: 'barter_completed',
      title: 'Troca concluída',
      body: expect.stringMatching(/^Torna de R\$\s200,00 paga ao outro lado\.$/),
      data: { barterId: 7 },
    });
    expect(notify).toHaveBeenCalledWith(2, {
      type: 'barter_completed',
      title: 'Troca concluída',
      body: expect.stringMatching(
        /^Torna de R\$\s170,00 creditada na sua carteira \(taxa de R\$\s30,00\)\.$/,
      ),
      data: { barterId: 7 },
    });
  });

  it('troca sem torna reservada: os dois recebem só o aviso de troca fechada', async () => {
    repo.findById.mockResolvedValue(
      active({
        cash_difference: '0.00',
        cash_payer_id: null,
        platform_fee: '0.00',
        torna_status: 'none',
      }),
    );
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);

    await barterService.onLinkedContractCompleted(1);

    const payload = {
      type: 'barter_completed',
      title: 'Troca concluída',
      body: 'Os dois lados entregaram e aprovaram. Troca fechada.',
      data: { barterId: 1 },
    };
    expect(notify.mock.calls).toEqual([
      [1, payload],
      [2, payload],
    ]);
  });
});

describe('onLinkedContractCancelled: quando não disputa e o que avisa', () => {
  it('troca inexistente ou fora de active: não entra em disputa', async () => {
    for (const row of [
      undefined,
      fakeBarter({ status: 'proposed' }),
      fakeBarter({ status: 'disputed' }),
    ]) {
      repo.findById.mockResolvedValue(row);
      await barterService.onLinkedContractCancelled(1);
    }
    expect(repo.disputeAndRefund).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('se o repository não mudou nada (corrida), ninguém é avisado', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active', torna_status: 'held' }));
    repo.disputeAndRefund.mockResolvedValue(false);
    await barterService.onLinkedContractCancelled(1);
    expect(repo.disputeAndRefund).toHaveBeenCalledWith(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('com torna reservada, os dois lados são avisados de que o valor voltou a quem pagou', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active', torna_status: 'held' }));
    repo.disputeAndRefund.mockResolvedValue(true);

    await barterService.onLinkedContractCancelled(7);

    const payload = {
      type: 'barter_disputed',
      title: 'Troca em disputa',
      body: expect.stringMatching(
        /^Um dos contratos foi cancelado\. A torna de R\$\s200,00 voltou para a carteira de quem pagou\.$/,
      ),
      data: { barterId: 7 },
    };
    expect(notify.mock.calls).toEqual([
      [1, payload],
      [2, payload],
    ]);
  });

  it('sem torna reservada (pendente ou troca equilibrada), o aviso não fala em devolução', async () => {
    const payload = {
      type: 'barter_disputed',
      title: 'Troca em disputa',
      body: 'Um dos contratos foi cancelado; o outro segue o próprio fluxo.',
      data: { barterId: 1 },
    };
    for (const o of [
      { torna_status: 'pending' },
      { torna_status: 'held', cash_difference: '0.00' },
    ]) {
      notify.mockClear();
      repo.findById.mockResolvedValue(fakeBarter({ status: 'active', ...o }));
      repo.disputeAndRefund.mockResolvedValue(true);
      await barterService.onLinkedContractCancelled(1);
      expect(notify.mock.calls).toEqual([
        [1, payload],
        [2, payload],
      ]);
    }
  });

  it('a disputa é do acordo do contrato cancelado: lê e disputa pelo id recebido', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active', torna_status: 'held' }));
    repo.disputeAndRefund.mockResolvedValue(true);
    await barterService.onLinkedContractCancelled(7);
    expect(repo.findById.mock.calls).toEqual([[7]]);
    expect(repo.disputeAndRefund.mock.calls).toEqual([[7]]);
    // A disputa não conclui nem liquida nada.
    expect(repo.completeAndRelease).not.toHaveBeenCalled();
  });
});

/**
 * Reforços da revisão: condições que os casos acima deixavam passar se uma metade da regra
 * sumisse (cada condição composta ganha um caso em que só ela decide).
 */
describe('propose: condições isoladas', () => {
  it('as trocas desligadas barram antes de qualquer outra regra, até a de troca consigo mesmo', async () => {
    settings.barterEnabled.mockResolvedValueOnce(false);
    await expect(barterService.propose(2, proposal)).rejects.toMatchObject({
      statusCode: 403,
      code: 'barter_disabled',
      message: 'As trocas estão desativadas no momento',
    });
    expect(settings.feeRate).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('troca consigo mesmo não chega a consultar a taxa nem a gravar', async () => {
    await expect(barterService.propose(2, proposal)).rejects.toMatchObject({
      statusCode: 400,
      code: 'self_barter',
      message: 'Você não pode propor uma troca consigo mesmo',
    });
    expect(settings.feeRate).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('quem recebe mais valor paga a diferença (RN-066): um centavo já define o pagador e a reserva', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());

    // Oferece 800,01 por algo de 800: o receptor leva mais, paga 0,01 e só reserva no aceite.
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 800.01,
      estimatedValueRequested: 800,
    });
    expect(repo.create.mock.calls[0]![0]).toMatchObject({
      cashDifference: 0.01,
      cashPayerId: 2,
      platformFee: 0,
      tornaStatus: 'pending',
    });
    expect(repo.create.mock.calls[0]![1]).toBeNull();

    // Oferece 800 por algo de 800,01: o proponente leva mais e reserva 0,01 já na proposta.
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 800,
      estimatedValueRequested: 800.01,
    });
    expect(repo.create.mock.calls[1]![0]).toMatchObject({
      cashDifference: 0.01,
      cashPayerId: 1,
      tornaStatus: 'none',
    });
    expect(repo.create.mock.calls[1]![1]).toEqual({ userId: 1, amount: 0.01 });
  });

  it('a taxa é cobrada sobre a torna, não sobre o valor dos serviços (RN-066)', async () => {
    settings.feeRate.mockResolvedValueOnce(0.2);
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 5000,
      estimatedValueRequested: 4900,
    });
    // 20% de 100 (a torna); sobre 5000 seriam 1000, sobre 4900 seriam 980.
    expect(repo.create.mock.calls[0]![0]).toMatchObject({ cashDifference: 100, platformFee: 20 });
    expect(settings.feeRate).toHaveBeenCalledTimes(1);
  });

  it('sem saldo do proponente o erro é o 402 de quem propõe, com o valor da torna desta proposta', async () => {
    repo.create.mockResolvedValue(null);
    await expect(
      barterService.propose(1, {
        ...proposal,
        estimatedValueOffered: 100,
        estimatedValueRequested: 149.9,
      }),
    ).rejects.toMatchObject({
      statusCode: 402,
      code: 'insufficient_balance',
      message: expect.stringMatching(/^Saldo insuficiente para reservar a torna de R\$\s49,90\. /),
    });
  });

  it('se o acordo recém-criado não é mais encontrado, o erro é 404 e não um acordo vazio', async () => {
    repo.create.mockResolvedValue(42);
    repo.findById.mockResolvedValue(undefined);
    await expect(barterService.propose(1, proposal)).rejects.toMatchObject({
      statusCode: 404,
      code: 'barter_not_found',
      message: 'Troca não encontrada',
    });
    expect(repo.findById.mock.calls).toEqual([[42]]);
  });
});

describe('accept: condições isoladas', () => {
  it('só o receptor aceita: a recusa diz isso, e nem um terceiro nem o proponente passam', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    for (const uid of [1, 99]) {
      await expect(barterService.accept(1, uid)).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
        message: 'Apenas quem recebeu a proposta pode aceitar',
      });
    }
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it('quem não é o receptor recebe 403 mesmo com a troca já fora de proposed (não revela o estado)', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'active' }));
    await expect(barterService.accept(1, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
  });

  it('torna pendente sem pagador registrado não gera reserva (não reserva na carteira de ninguém)', async () => {
    repo.findById.mockResolvedValue(
      fakeBarter({ cash_difference: '200.00', cash_payer_id: null, torna_status: 'pending' }),
    );
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });
    await barterService.accept(1, 2);
    expect(repo.accept.mock.calls[0]![0].hold).toBeNull();
  });

  it('torna já devolvida ou paga não é reservada de novo no aceite', async () => {
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });
    for (const torna_status of ['refunded', 'paid', 'none']) {
      repo.findById.mockResolvedValue(fakeBarter({ cash_payer_id: 2, torna_status }));
      await barterService.accept(1, 2);
    }
    expect(repo.accept.mock.calls.map(([arg]) => arg.hold)).toEqual([null, null, null]);
  });

  it('os contratos saem com o valor estimado de cada lado, em número, e o id do acordo aceito', async () => {
    const row = {
      ...fakeBarter(),
      estimated_value_offered: '1234.56',
      estimated_value_requested: '0.99',
      requested_service_id: 32,
    } as BarterRow;
    repo.findById.mockResolvedValue(row);
    repo.accept.mockResolvedValue({ ok: true, contractOfferedId: 10, contractRequestedId: 11 });

    await barterService.accept(9, 2);

    const arg = repo.accept.mock.calls[0]![0];
    expect(arg.agreementId).toBe(9);
    expect(arg.acceptorId).toBe(2);
    expect(arg.contractOffered).toMatchObject({ price: 1234.56, serviceId: null });
    expect(arg.contractRequested).toMatchObject({ price: 0.99, serviceId: 32 });
    expect(repo.findById.mock.calls).toEqual([[9], [9]]);
  });

  it('aceite em corrida: a mensagem manda recarregar', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    repo.accept.mockResolvedValue({ ok: false, reason: 'conflict' });
    await expect(barterService.accept(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
      message: 'A troca mudou de estado; recarregue',
    });
  });
});

describe('reject e cancel: o que chega ao repository', () => {
  it('recusar e cancelar agem sobre o id pedido, uma vez só', async () => {
    repo.findById.mockResolvedValue(fakeBarter());
    repo.setStatusFromProposed.mockResolvedValue(true);

    await barterService.reject(9, 2);
    expect(repo.findById).toHaveBeenLastCalledWith(9);
    expect(repo.setStatusFromProposed.mock.calls).toEqual([[9, 'rejected']]);

    await barterService.cancel(8, 1);
    expect(repo.findById).toHaveBeenLastCalledWith(8);
    expect(repo.setStatusFromProposed.mock.calls).toEqual([
      [9, 'rejected'],
      [8, 'cancelled'],
    ]);
    // Recusar e cancelar não geram contrato nem aviso.
    expect(repo.accept).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('recusa em corrida (o repository devolve false com a troca lida ainda proposed) também é 409', async () => {
    repo.findById.mockResolvedValue(fakeBarter({ status: 'proposed' }));
    repo.setStatusFromProposed.mockResolvedValue(false);
    await expect(barterService.reject(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_status',
    });
  });
});

describe('onLinkedContractCompleted: condições isoladas', () => {
  const active = (o: FakeBarterFields = {}): BarterRow =>
    fakeBarter({
      status: 'active',
      torna_status: 'held',
      contract_offered_id: 10,
      contract_requested_id: 11,
      ...o,
    });
  const closed = {
    type: 'barter_completed',
    title: 'Troca concluída',
    body: 'Os dois lados entregaram e aprovaram. Troca fechada.',
    data: { barterId: 1 },
  };

  it('lê e conclui o acordo pelo id recebido', async () => {
    repo.findById.mockResolvedValue(active());
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);
    await barterService.onLinkedContractCompleted(7);
    expect(repo.findById.mock.calls).toEqual([[7]]);
    expect(repo.completeAndRelease.mock.calls).toEqual([[7]]);
    expect(repo.disputeAndRefund).not.toHaveBeenCalled();
  });

  it('torna que nunca foi reservada (pendente) não é anunciada como paga, mesmo com valor', async () => {
    repo.findById.mockResolvedValue(active({ torna_status: 'pending', cash_difference: '200.00' }));
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);
    await barterService.onLinkedContractCompleted(1);
    expect(notify.mock.calls).toEqual([
      [1, closed],
      [2, closed],
    ]);
  });

  it('reserva de valor zero também só gera o aviso de troca fechada', async () => {
    repo.findById.mockResolvedValue(
      active({ torna_status: 'held', cash_difference: '0.00', platform_fee: '0.00' }),
    );
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);
    await barterService.onLinkedContractCompleted(1);
    expect(notify.mock.calls).toEqual([
      [1, closed],
      [2, closed],
    ]);
  });

  it('os dois contratos precisam estar concluídos: nenhum outro estado final serve', async () => {
    repo.findById.mockResolvedValue(active());
    for (const status of ['delivered', 'cancelled', 'disputed', 'accepted']) {
      contracts.findById
        .mockResolvedValueOnce(contractStatus('completed'))
        .mockResolvedValueOnce(contractStatus(status));
      await barterService.onLinkedContractCompleted(1);
      contracts.findById
        .mockResolvedValueOnce(contractStatus(status))
        .mockResolvedValueOnce(contractStatus('completed'));
      await barterService.onLinkedContractCompleted(1);
    }
    expect(repo.completeAndRelease).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * Arredondamento em centavos: os casos acima usam valores redondos, em que tirar o `money()` ou
 * o ajuste contra o ponto flutuante não mudaria nada. Estes só passam com o arredondamento certo.
 */
describe('valores em centavos', () => {
  it('taxa de meio centavo exato sobe, mesmo quando o ponto flutuante cai logo abaixo', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    // Torna de 4,30 a 15% dá 0,645; em ponto flutuante 0.15 * 4.3 é 0.6449999999999999, que um
    // arredondamento ingênuo levaria a 0,64.
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 104.3,
      estimatedValueRequested: 100,
    });
    const [data] = repo.create.mock.calls[0]!;
    // 104.3 − 100 em ponto flutuante é 4.299999999999997: a torna gravada é 4,30.
    expect(data.cashDifference).toBe(4.3);
    expect(data.platformFee).toBe(0.65);
  });

  it('diferença menor que um centavo não é torna: não reserva zero na carteira do proponente', async () => {
    repo.create.mockResolvedValue(1);
    repo.findById.mockResolvedValue(fakeBarter());
    // O proponente levaria 0,004 a mais: arredonda para zero, então não há o que reservar.
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 800,
      estimatedValueRequested: 800.004,
    });
    const [data, hold] = repo.create.mock.calls[0]!;
    expect(data).toMatchObject({ cashDifference: 0, platformFee: 0, tornaStatus: 'none' });
    expect(hold).toBeNull();

    // No outro sentido (o receptor levaria 0,004 a mais) também não fica torna pendente.
    await barterService.propose(1, {
      ...proposal,
      estimatedValueOffered: 800.004,
      estimatedValueRequested: 800,
    });
    const [data2, hold2] = repo.create.mock.calls[1]!;
    expect(data2).toMatchObject({ cashDifference: 0, platformFee: 0, tornaStatus: 'none' });
    expect(hold2).toBeNull();
  });

  it('o líquido da torna devolvido à API é arredondado em centavos', async () => {
    // 0.30 − 0.10 em ponto flutuante dá 0.19999999999999998: a API devolve 0.2.
    repo.findById.mockResolvedValue(fakeBarter({ cash_difference: '0.30', platform_fee: '0.10' }));
    const b = await barterService.getById(1, 1);
    expect(b.cashDifference).toBe(0.3);
    expect(b.platformFee).toBe(0.1);
    expect(b.tornaNet).toBe(0.2);
  });

  it('o aviso de conclusão mostra o líquido em reais com centavos (torna − taxa)', async () => {
    repo.findById.mockResolvedValue(
      fakeBarter({
        status: 'active',
        torna_status: 'held',
        cash_difference: '49.90',
        platform_fee: '7.49',
        contract_offered_id: 10,
        contract_requested_id: 11,
      }),
    );
    contracts.findById.mockResolvedValue(contractStatus('completed'));
    repo.completeAndRelease.mockResolvedValue(true);

    await barterService.onLinkedContractCompleted(1);

    // Quem paga é o receptor (2); o proponente (1) recebe 49,90 − 7,49 = 42,41.
    expect(notify.mock.calls.map(([uid, n]) => [uid, n.body])).toEqual([
      [
        1,
        expect.stringMatching(
          /^Torna de R\$\s42,41 creditada na sua carteira \(taxa de R\$\s7,49\)\.$/,
        ),
      ],
      [2, expect.stringMatching(/^Torna de R\$\s49,90 paga ao outro lado\.$/)],
    ]);
  });
});
