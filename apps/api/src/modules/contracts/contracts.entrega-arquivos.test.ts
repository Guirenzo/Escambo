vi.mock('../dropouts/dropouts.repository', () => ({
  dropoutsRepository: {
    listCounting: vi.fn().mockResolvedValue([]),
    findByContractId: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../dropouts/dropouts.service', () => ({
  dropoutsService: { afterDropout: vi.fn().mockResolvedValue(undefined) },
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings/settings.service', () => ({
  settingsService: {
    feeRate: vi.fn().mockResolvedValue(0.15),
    number: vi.fn().mockResolvedValue(24),
  },
}));
vi.mock('../settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn().mockResolvedValue(5) },
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
    deliver: vi.fn(),
  },
}));
vi.mock('./offers.repository', () => ({
  offersRepository: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('./contracts.repository', () => ({
  contractsRepository: {
    findById: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    listDeliveries: vi.fn().mockResolvedValue([]),
    deliver: vi.fn(),
  },
}));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../barter/barter.service', () => ({
  barterService: { onLinkedContractCompleted: vi.fn(), onLinkedContractCancelled: vi.fn() },
}));
// Os anexos do chat (ADR 29): conferir e gravar no disco, descartar e anunciar no tempo real.
vi.mock('../messaging/messaging.service', () => ({
  storeAttachments: vi.fn(),
  discardAttachments: vi.fn().mockResolvedValue(undefined),
  messagingService: { announceStored: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../messaging/messaging.repository', () => ({
  messagingRepository: { getOrCreate: vi.fn().mockResolvedValue(55) },
}));
vi.mock('./delivery-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery-files')>()),
  deliveryFilesRepository: { listForContract: vi.fn().mockResolvedValue([]), attach: vi.fn() },
}));

import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import {
  discardAttachments,
  messagingService,
  storeAttachments,
  type StoredAttachment,
} from '../messaging/messaging.service';
import { messagingRepository } from '../messaging/messaging.repository';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { contractsService } from './contracts.service';
import { deliveryFilesRepository, type DeliveryFileRow } from './delivery-files';
import { milestonesRepository, type MilestoneRow } from './milestones.repository';

/**
 * Entrega com arquivo no service (RF-035): quem pode e em que status é conferido antes de gravar
 * qualquer arquivo; os arquivos vão para o disco antes da transação e saem se a entrega não for
 * gravada; gravada, aparecem no chat do par em tempo real.
 */

const repo = vi.mocked(contractsRepository);
const ms = vi.mocked(milestonesRepository);
const files = vi.mocked(deliveryFilesRepository);
const store = vi.mocked(storeAttachments);
const discard = vi.mocked(discardAttachments);
const announce = vi.mocked(messagingService.announceStored);
const conversation = vi.mocked(messagingRepository.getOrCreate);

const row = (o: Record<string, unknown> = {}): ContractRow =>
  ({
    id: 1,
    ulid: '01CONTRACTULID000000000000',
    client_id: 1,
    freelancer_id: 2,
    service_id: null,
    title: 'Identidade visual',
    description: 'Logo e manual',
    price: '300.00',
    platform_fee: '45.00',
    freelancer_net: '255.00',
    status: 'in_progress',
    payment_mode: 'cash',
    deadline_at: null,
    accepted_at: new Date('2026-10-01T12:00:00Z'),
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-10-01T00:00:00Z'),
    ...o,
  }) as unknown as ContractRow;

const upload = (name: string, bytes = 10) => ({
  buffer: Buffer.alloc(bytes, 1),
  originalname: name,
});
const stored = (key: string): StoredAttachment => ({
  key,
  kind: 'file',
  name: `${key}.pdf`,
  mime: 'application/pdf',
  size: 10,
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.findById.mockResolvedValue(row());
  repo.deliver.mockResolvedValue(true);
  ms.deliver.mockResolvedValue(true);
  conversation.mockResolvedValue(55);
  store.mockImplementation(async (list) => list.map((f) => stored(f.originalname!)));
});

describe('entrega única com arquivos', () => {
  it('confere, grava no disco e entrega os arquivos à transação da entrega, ligados à conversa do par', async () => {
    const uploads = [upload('logo'), upload('manual')];
    await contractsService.deliver(1, 2, { message: 'Pronto' }, uploads);

    expect(conversation).toHaveBeenCalledWith(1, 2, 1);
    expect(store).toHaveBeenCalledWith(uploads);
    expect(repo.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        message: 'Pronto',
        attachments: { conversationId: 55, senderId: 2, files: [stored('logo'), stored('manual')] },
      }),
    );
    // Gravada a entrega, os arquivos aparecem no chat aberto das duas partes.
    expect(announce).toHaveBeenCalledWith(1, 55, ['logo', 'manual']);
    expect(discard).not.toHaveBeenCalled();
  });

  it('sem arquivo, nada vai para o disco nem para a conversa, e a entrega segue como antes', async () => {
    await contractsService.deliver(1, 2, { message: 'Pronto', files: ['https://a.test/x'] });
    expect(store).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
    expect(repo.deliver.mock.calls[0]![0]).not.toHaveProperty('attachments');
    expect(announce).not.toHaveBeenCalled();
  });

  it('quem não é o freelancer, ou a contratação fora do status, é recusado antes de gravar arquivo', async () => {
    await expect(
      contractsService.deliver(1, 1, { message: 'Eu entrego' }, [upload('a')]),
    ).rejects.toMatchObject({ statusCode: 403 });
    repo.findById.mockResolvedValue(row({ status: 'delivered' }));
    await expect(
      contractsService.deliver(1, 2, { message: 'De novo' }, [upload('a')]),
    ).rejects.toMatchObject({ statusCode: 409, code: 'invalid_transition' });
    repo.findById.mockResolvedValue(row({ has_milestones: 1 }));
    await expect(
      contractsService.deliver(1, 2, { message: 'Tudo' }, [upload('a')]),
    ).rejects.toMatchObject({ statusCode: 409, code: 'use_milestones' });
    expect(store).not.toHaveBeenCalled();
    expect(repo.deliver).not.toHaveBeenCalled();
  });

  it('mais de 10 arquivos é 422 too_many_files; mais de 24 MB somados é 413 files_too_large; nada gravado', async () => {
    await expect(
      contractsService.deliver(
        1,
        2,
        { message: 'Pronto' },
        Array.from({ length: 11 }, (_, i) => upload(`f${i}`)),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'too_many_files',
      message: 'Envie no máximo 10 arquivos por entrega',
    });
    await expect(
      contractsService.deliver(1, 2, { message: 'Pronto' }, [
        upload('a', 12 * 1024 * 1024),
        upload('b', 12 * 1024 * 1024 + 1),
      ]),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: 'files_too_large',
      message: 'Os arquivos da entrega somam mais de 24 MB: mande os maiores pelo chat ou por link',
    });
    expect(store).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
  });

  it('a recusa do tipo ou do arquivo vazio vem dos anexos do chat e nada é entregue', async () => {
    store.mockRejectedValueOnce(
      new HttpError(422, 'Tipo de arquivo não aceito (a.txt): envie …', 'unsupported_file_type'),
    );
    await expect(
      contractsService.deliver(1, 2, { message: 'Pronto' }, [upload('a.txt')]),
    ).rejects.toMatchObject({ statusCode: 422, code: 'unsupported_file_type' });
    expect(repo.deliver).not.toHaveBeenCalled();
  });

  it('a entrega não gravada (corrida ou falha do banco) tira os arquivos do disco', async () => {
    repo.deliver.mockResolvedValueOnce(false);
    await expect(
      contractsService.deliver(1, 2, { message: 'Pronto' }, [upload('a')]),
    ).rejects.toMatchObject({ statusCode: 409, code: 'conflict' });
    expect(discard).toHaveBeenLastCalledWith([stored('a')]);

    const boom = new Error('deadlock');
    repo.deliver.mockRejectedValueOnce(boom);
    await expect(contractsService.deliver(1, 2, { message: 'Pronto' }, [upload('b')])).rejects.toBe(
      boom,
    );
    expect(discard).toHaveBeenLastCalledWith([stored('b')]);
    expect(announce).not.toHaveBeenCalled();
  });

  it('o anúncio no chat é melhor esforço: se falhar, a entrega fica e o erro vai para o log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    announce.mockRejectedValueOnce(new Error('socket fora'));
    const c = await contractsService.deliver(1, 2, { message: 'Pronto' }, [upload('a')]);
    expect(c.id).toBe(1);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: 1 }),
        'entrega: arquivos não anunciados no chat em tempo real',
      ),
    );
    warn.mockRestore();
  });
});

describe('entrega de marco com arquivos', () => {
  it('os arquivos vão na transação do marco; marco que não aguarda entrega descarta os arquivos', async () => {
    await contractsService.deliverMilestone(1, 7, 2, 'Layout', [upload('layout')]);
    expect(ms.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: 1,
        milestoneId: 7,
        message: 'Layout',
        attachments: { conversationId: 55, senderId: 2, files: [stored('layout')] },
      }),
    );
    expect(announce).toHaveBeenCalledWith(1, 55, ['layout']);

    ms.deliver.mockResolvedValueOnce(false);
    await expect(
      contractsService.deliverMilestone(1, 7, 2, 'Layout', [upload('outra')]),
    ).rejects.toMatchObject({ statusCode: 409, code: 'invalid_transition' });
    expect(discard).toHaveBeenLastCalledWith([stored('outra')]);

    const boom = new Error('falhou');
    ms.deliver.mockRejectedValueOnce(boom);
    await expect(
      contractsService.deliverMilestone(1, 7, 2, 'Layout', [upload('mais')]),
    ).rejects.toBe(boom);
    expect(discard).toHaveBeenLastCalledWith([stored('mais')]);
  });

  it('sem arquivo, o marco é entregue como antes, sem attachments', async () => {
    await contractsService.deliverMilestone(1, 7, 2, 'Layout');
    expect(ms.deliver.mock.calls[0]![0]).not.toHaveProperty('attachments');
    expect(store).not.toHaveBeenCalled();
  });
});

describe('a Sala lê os arquivos de cada entrega', () => {
  const fileRow = (
    o: Partial<Omit<DeliveryFileRow, 'constructor'>> & { message_id: number },
  ): DeliveryFileRow =>
    ({
      delivery_id: null,
      milestone_id: null,
      file_name: 'final.pdf',
      file_mime: 'application/pdf',
      file_size_bytes: 2048,
      file_purged_at: null,
      file_purged_reason: null,
      removed_at: null,
      created_at: new Date('2026-10-04T18:30:00Z'),
      ...o,
    }) as unknown as DeliveryFileRow;

  it('com arquivos, cada entrega única e cada marco recebe os seus; sem a marca, nem consulta', async () => {
    repo.findById.mockResolvedValue(
      row({ status: 'delivered', deliveries_count: 2, has_delivery_files: 1, has_milestones: 1 }),
    );
    repo.listDeliveries.mockResolvedValue([
      { id: 3, message: 'Primeira', files: null, delivered_at: new Date('2026-10-02T12:00:00Z') },
      { id: 5, message: 'Segunda', files: null, delivered_at: new Date('2026-10-04T18:30:00Z') },
    ] as never);
    ms.listForContract.mockResolvedValue([
      { id: 7, status: 'delivered', amount: '150.00', freelancer_net: '127.50' },
      { id: 8, status: 'funded', amount: '150.00', freelancer_net: '127.50' },
    ] as unknown as MilestoneRow[]);
    files.listForContract.mockResolvedValue([
      fileRow({ message_id: 40, delivery_id: 3 }),
      fileRow({ message_id: 41, delivery_id: 5, file_name: 'v2.pdf' }),
      fileRow({ message_id: 42, milestone_id: 7, file_name: 'layout.png', file_mime: 'image/png' }),
    ]);

    const c = await contractsService.getById(1, 1);
    expect(files.listForContract).toHaveBeenCalledWith(1);
    expect(c.deliveries!.map((d) => [d.id, d.attachments!.map((a) => a.name)])).toEqual([
      [3, ['final.pdf']],
      [5, ['v2.pdf']],
    ]);
    expect(c.milestones.map((m) => [m.id, m.attachments!.map((a) => a.url)])).toEqual([
      [7, ['/api/messaging/attachments/42']],
      [8, []],
    ]);

    files.listForContract.mockClear();
    repo.findById.mockResolvedValue(row({ status: 'delivered', deliveries_count: 1 }));
    repo.listDeliveries.mockResolvedValue([
      { id: 3, message: 'Só texto', files: null, delivered_at: new Date('2026-10-02T12:00:00Z') },
    ] as never);
    const plain = await contractsService.getById(1, 2);
    expect(files.listForContract).not.toHaveBeenCalled();
    expect(plain.deliveries![0]!.attachments).toEqual([]);
  });
});
