import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./disputes.repository', () => ({
  disputesRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listForUser: vi.fn(),
    listOpen: vi.fn(),
    resolve: vi.fn(),
  },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn().mockResolvedValue(undefined) },
}));

import { disputesService } from './disputes.service';
import { disputesRepository, type DisputeRow } from './disputes.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';

const disputes = vi.mocked(disputesRepository);
const contracts = vi.mocked(contractsRepository);
const notify = vi.mocked(notificationsService.notify);

const contractRow = (
  o: Partial<{ client_id: number; freelancer_id: number; status: string }> = {},
): ContractRow =>
  ({
    id: 1,
    client_id: 1,
    freelancer_id: 2,
    freelancer_net: '850.00',
    status: 'delivered',
    ...o,
  }) as unknown as ContractRow;

const disputeRow = (o: Partial<{ id: number; status: string }> = {}): DisputeRow =>
  ({
    id: 1,
    ulid: '01DISPUTE',
    contract_id: 1,
    opened_by: 1,
    reason: 'quality',
    description: 'entrega ruim',
    status: 'open',
    resolution: null,
    refund_percentage: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as DisputeRow;

const input = {
  contractId: 1,
  reason: 'quality' as const,
  description: 'a entrega veio incompleta',
};

beforeEach(() => vi.clearAllMocks());

describe('disputesService.open', () => {
  it('404 quando o contrato não existe', async () => {
    contracts.findById.mockResolvedValue(undefined);
    await expect(disputesService.open(1, input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 quando não é parte do contrato', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    await expect(disputesService.open(99, input)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('409 quando o contrato não permite disputa', async () => {
    contracts.findById.mockResolvedValue(contractRow());
    disputes.create.mockResolvedValue(null);
    await expect(disputesService.open(1, input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('abre a disputa', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));
    const d = await disputesService.open(1, input);
    expect(d.id).toBe(7);
    expect(d.status).toBe('open');
  });

  it('os erros saem com o código que o front trata, e a recusa não grava nem avisa ninguém', async () => {
    contracts.findById.mockResolvedValue(undefined);
    await expect(disputesService.open(1, input)).rejects.toMatchObject({
      statusCode: 404,
      code: 'contract_not_found',
    });

    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    await expect(disputesService.open(99, input)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    // Quem não participa nem chega a tentar abrir.
    expect(disputes.create).not.toHaveBeenCalled();

    disputes.create.mockResolvedValue(null);
    await expect(disputesService.open(1, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'not_disputable',
    });
    expect(disputes.findById).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('grava a disputa com um ulid novo, em nome de quem abriu, sem a guarda da disputa automática', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));

    await disputesService.open(2, { ...input, contractId: 5 });

    expect(contracts.findById).toHaveBeenCalledWith(5);
    expect(disputes.create).toHaveBeenCalledTimes(1);
    // Um argumento só: a guarda (ADR 57) é da disputa automática do job, não da aberta por uma parte.
    expect(disputes.create).toHaveBeenCalledWith({
      ulid: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      contractId: 5,
      openedBy: 2,
      reason: 'quality',
      description: 'a entrega veio incompleta',
    });
    expect(disputes.findById).toHaveBeenCalledWith(7);
  });

  it('avisa a outra parte da contratação: o freelancer quando o cliente abre, o cliente quando o freelancer abre', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));
    const notice = {
      type: 'dispute_opened',
      title: 'Disputa aberta na contratação',
      body: 'A mediação do Escambo vai analisar e decidir sobre o valor em escrow.',
      data: { contractId: 1, disputeId: 7 },
    };

    await disputesService.open(1, input);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(2, notice);

    await disputesService.open(2, input);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(1, notice);
  });

  it('a abertura não espera o aviso sair: com o envio pendente, a disputa já gravada é devolvida', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));
    // Aviso que nunca termina (e-mail/push lento): quem abriu não fica preso nele.
    notify.mockReturnValueOnce(new Promise<void>(() => undefined));

    expect(await disputesService.open(1, input)).toMatchObject({ id: 7, status: 'open' });
    expect(notify).toHaveBeenCalledTimes(1);
    // O aviso só sai depois de a disputa estar gravada.
    expect(disputes.create.mock.invocationCallOrder[0]!).toBeLessThan(
      notify.mock.invocationCallOrder[0]!,
    );
  });

  it('a participação é conferida antes de gravar: a contratação é lida uma vez, pelo id pedido', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));

    await disputesService.open(1, { ...input, contractId: 5 });

    expect(contracts.findById.mock.calls).toEqual([[5]]);
    expect(contracts.findById.mock.invocationCallOrder[0]!).toBeLessThan(
      disputes.create.mock.invocationCallOrder[0]!,
    );
  });

  it('devolve a disputa no formato da API (camelCase, data em ISO)', async () => {
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));
    disputes.create.mockResolvedValue(7);
    disputes.findById.mockResolvedValue(disputeRow({ id: 7 }));

    expect(await disputesService.open(1, input)).toEqual({
      id: 7,
      ulid: '01DISPUTE',
      contractId: 1,
      openedBy: 1,
      reason: 'quality',
      description: 'entrega ruim',
      status: 'open',
      resolution: null,
      refundPercentage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('disputesService.listMine', () => {
  it('lista as disputas das contratações de quem pede, no formato da API', async () => {
    disputes.listForUser.mockResolvedValue([
      disputeRow({ id: 9, status: 'resolved' }),
      disputeRow({ id: 4 }),
    ]);

    const list = await disputesService.listMine(2);

    expect(disputes.listForUser).toHaveBeenCalledTimes(1);
    expect(disputes.listForUser).toHaveBeenCalledWith(2);
    expect(list.map((d) => [d.id, d.status, d.contractId, d.createdAt])).toEqual([
      [9, 'resolved', 1, '2026-01-01T00:00:00.000Z'],
      [4, 'open', 1, '2026-01-01T00:00:00.000Z'],
    ]);
  });

  it('sem disputas, devolve lista vazia', async () => {
    disputes.listForUser.mockResolvedValue([]);
    expect(await disputesService.listMine(2)).toEqual([]);
  });
});

describe('disputesService.getById', () => {
  it('404 dispute_not_found quando a disputa não existe, sem consultar a contratação', async () => {
    disputes.findById.mockResolvedValue(undefined);
    await expect(disputesService.getById(31, 1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'dispute_not_found',
    });
    expect(disputes.findById).toHaveBeenCalledWith(31);
    expect(contracts.findById).not.toHaveBeenCalled();
  });

  it('só as partes da contratação veem a disputa: terceiro recebe 403', async () => {
    disputes.findById.mockResolvedValue({
      ...disputeRow({ id: 31 }),
      contract_id: 8,
    } as DisputeRow);
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));

    await expect(disputesService.getById(31, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    // A participação é conferida na contratação DA disputa.
    expect(contracts.findById).toHaveBeenCalledWith(8);
  });

  it('se a contratação da disputa sumiu, ninguém vê: 403', async () => {
    disputes.findById.mockResolvedValue(disputeRow({ id: 31 }));
    contracts.findById.mockResolvedValue(undefined);
    await expect(disputesService.getById(31, 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
  });

  it('cliente e freelancer da contratação recebem a disputa no formato da API', async () => {
    disputes.findById.mockResolvedValue(disputeRow({ id: 31, status: 'under_review' }));
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));

    for (const uid of [1, 2]) {
      expect(await disputesService.getById(31, uid)).toEqual({
        id: 31,
        ulid: '01DISPUTE',
        contractId: 1,
        openedBy: 1,
        reason: 'quality',
        description: 'entrega ruim',
        status: 'under_review',
        resolution: null,
        refundPercentage: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
  });

  it('disputa resolvida mostra às partes a decisão e o percentual devolvido; a data vale também como texto do driver', async () => {
    disputes.findById.mockResolvedValue({
      ...disputeRow({ id: 31, status: 'resolved' }),
      contract_id: 8,
      opened_by: 2,
      reason: 'deadline',
      resolution: 'partial_split',
      refund_percentage: 30,
      created_at: '2026-03-05 10:20:30Z',
    } as unknown as DisputeRow);
    contracts.findById.mockResolvedValue(contractRow({ client_id: 1, freelancer_id: 2 }));

    expect(await disputesService.getById(31, 2)).toEqual({
      id: 31,
      ulid: '01DISPUTE',
      contractId: 8,
      openedBy: 2,
      reason: 'deadline',
      description: 'entrega ruim',
      status: 'resolved',
      resolution: 'partial_split',
      refundPercentage: 30,
      createdAt: '2026-03-05T10:20:30.000Z',
    });
  });
});
