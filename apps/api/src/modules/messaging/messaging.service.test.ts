import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging.repository', () => ({
  messagingRepository: {
    getOrCreate: vi.fn(),
    listMessages: vi.fn(),
    insertMessage: vi.fn(),
    previousMessage: vi.fn(),
    findAttachment: vi.fn(),
    markPurged: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));
vi.mock('../profiles/profiles.repository', () => ({
  profilesRepository: { blendResponseTime: vi.fn() },
}));
vi.mock('../../config/realtime', () => ({
  realtime: { emitToContract: vi.fn() },
}));
// Detecção de tipo e nomes são puros (testados à parte); só o disco é simulado.
vi.mock('./attachments.storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attachments.storage')>()),
  saveAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  attachmentPath: vi.fn(),
  attachmentSize: vi.fn(),
}));

import { messagingService, notificationBody } from './messaging.service';
import { messagingRepository, type MessageRow } from './messaging.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';
import { realtime } from '../../config/realtime';
import * as storage from './attachments.storage';

const mRepo = vi.mocked(messagingRepository);
const cRepo = vi.mocked(contractsRepository);
const disk = vi.mocked(storage);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

const fakeContract = (o: Partial<{ client_id: number; freelancer_id: number }> = {}): ContractRow =>
  ({ id: 1, client_id: 10, freelancer_id: 20, ...o }) as unknown as ContractRow;

const fakeMsg = (o: Partial<Omit<MessageRow, 'constructor'>> = {}): MessageRow =>
  ({
    id: 1,
    conversation_id: 5,
    sender_id: 10,
    type: 'text',
    content: 'oi',
    file_url: null,
    file_name: null,
    file_mime: null,
    file_size_bytes: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as MessageRow;

beforeEach(() => vi.clearAllMocks());

describe('messagingService.history', () => {
  it('404 quando o contrato não existe', async () => {
    cRepo.findById.mockResolvedValue(undefined);
    await expect(messagingService.history(1, 10)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 quando o usuário não é parte do contrato', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    await expect(messagingService.history(1, 99)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('resolve a conversa e devolve mensagens + a outra parte', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.listMessages.mockResolvedValue([fakeMsg()]);

    const h = await messagingService.history(1, 10); // cliente

    expect(mRepo.getOrCreate).toHaveBeenCalledWith(10, 20, 1);
    expect(h.conversationId).toBe(5);
    expect(h.otherPartyId).toBe(20); // freelancer
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({
      id: 1,
      content: 'oi',
      senderId: 10,
      type: 'text',
      attachment: null,
    });
  });

  it('mensagem com anexo sai com type, nome, tipo, tamanho e a URL do download', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.listMessages.mockResolvedValue([
      fakeMsg({
        id: 7,
        type: 'image',
        content: null,
        file_url: '2026/09/01ABC.png',
        file_name: 'foto.png',
        file_mime: 'image/png',
        file_size_bytes: 1234,
      }),
    ]);

    const h = await messagingService.history(1, 10);

    expect(h.messages[0]).toEqual({
      id: 7,
      conversationId: 5,
      senderId: 10,
      type: 'image',
      content: '',
      attachment: {
        name: 'foto.png',
        mime: 'image/png',
        size: 1234,
        url: '/api/messaging/attachments/7',
        purgedAt: null,
        purgedReason: null,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      removedAt: null,
    });
  });
});

describe('messagingService.send', () => {
  it('persiste, transmite em tempo real e notifica a outra parte', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ sender_id: 20, content: 'resposta' }));

    const msg = await messagingService.send(1, 20, 'resposta'); // freelancer envia

    expect(mRepo.insertMessage).toHaveBeenCalledWith({
      conversationId: 5,
      senderId: 20,
      content: 'resposta',
    });
    expect(realtime.emitToContract).toHaveBeenCalledWith(
      1,
      'message:new',
      expect.objectContaining({ contractId: 1, content: 'resposta' }),
    );
    expect(notificationsService.notify).toHaveBeenCalledWith(
      10, // outra parte = cliente
      expect.objectContaining({ type: 'chat_message', data: { contractId: 1 } }),
    );
    expect(msg.content).toBe('resposta');
  });
});

describe('messagingService.sendAttachment (ADR 29)', () => {
  beforeEach(() => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    disk.saveAttachment.mockResolvedValue('2026/09/01KEY.png');
  });

  it('recusa tipo não aceito antes de tocar no disco ou no banco', async () => {
    await expect(
      messagingService.sendAttachment(
        1,
        10,
        { buffer: Buffer.from('<html>'), originalname: 'a.png' },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'unsupported_file_type' });
    await expect(
      messagingService.sendAttachment(
        1,
        10,
        { buffer: Buffer.alloc(0), originalname: 'a.png' },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'empty_file' });
    expect(disk.saveAttachment).not.toHaveBeenCalled();
    expect(mRepo.insertMessage).not.toHaveBeenCalled();
  });

  it('quem não é parte toma 403 e nada é gravado', async () => {
    await expect(
      messagingService.sendAttachment(1, 99, { buffer: PNG, originalname: 'a.png' }, null),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(disk.saveAttachment).not.toHaveBeenCalled();
  });

  it('grava o arquivo, insere a mensagem com o tipo real e notifica com a legenda', async () => {
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({
        id: 9,
        sender_id: 20,
        type: 'image',
        content: 'olha o rascunho',
        file_url: '2026/09/01KEY.png',
        file_name: 'rascunho.exe.png',
        file_mime: 'image/png',
        file_size_bytes: PNG.length,
      }),
    );

    const msg = await messagingService.sendAttachment(
      1,
      20,
      { buffer: PNG, originalname: 'rascunho.exe' },
      '  olha o rascunho ',
    );

    expect(disk.saveAttachment).toHaveBeenCalledWith(
      PNG,
      expect.objectContaining({ mime: 'image/png' }),
    );
    expect(mRepo.insertMessage).toHaveBeenCalledWith({
      conversationId: 5,
      senderId: 20,
      content: 'olha o rascunho',
      attachment: {
        kind: 'image',
        key: '2026/09/01KEY.png',
        name: 'rascunho.exe.png',
        mime: 'image/png',
        size: PNG.length,
      },
    });
    expect(msg.type).toBe('image');
    expect(msg.attachment?.url).toBe('/api/messaging/attachments/9');
    expect(realtime.emitToContract).toHaveBeenCalledWith(
      1,
      'message:new',
      expect.objectContaining({ contractId: 1, type: 'image' }),
    );
    expect(notificationsService.notify).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ body: 'olha o rascunho' }),
    );
  });

  it('sem legenda, a notificação diz o que foi enviado', async () => {
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({
        type: 'image',
        content: null,
        file_url: 'k.png',
        file_name: 'a.png',
        file_mime: 'image/png',
      }),
    );
    await messagingService.sendAttachment(1, 10, { buffer: PNG }, null);
    expect(mRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: null,
        attachment: expect.objectContaining({ name: 'arquivo.png' }),
      }),
    );
    expect(notificationsService.notify).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ body: 'Enviou uma imagem' }),
    );
  });

  it('se o banco falhar depois de gravar o arquivo, o arquivo é removido e o erro sobe', async () => {
    mRepo.insertMessage.mockRejectedValue(new Error('db down'));
    await expect(
      messagingService.sendAttachment(1, 10, { buffer: PNG, originalname: 'a.png' }, null),
    ).rejects.toThrow('db down');
    expect(disk.removeAttachment).toHaveBeenCalledWith('2026/09/01KEY.png');
    expect(realtime.emitToContract).not.toHaveBeenCalled();
  });
});

describe('messagingService.attachment (download)', () => {
  const row = {
    id: 7,
    type: 'file' as const,
    file_url: '2026/09/K.pdf',
    file_name: 'briefing.pdf',
    file_mime: 'application/pdf',
    file_size_bytes: 10,
    participant_a: 10,
    participant_b: 20,
  };

  it('404 sem anexo, 403 para quem não é da conversa', async () => {
    mRepo.findAttachment.mockResolvedValue(undefined);
    await expect(messagingService.attachment(7, 10)).rejects.toMatchObject({ statusCode: 404 });
    mRepo.findAttachment.mockResolvedValue(row as never);
    await expect(messagingService.attachment(7, 99)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('404 attachment_missing quando o arquivo sumiu do disco', async () => {
    mRepo.findAttachment.mockResolvedValue(row as never);
    disk.attachmentPath.mockReturnValue('/data/uploads/2026/09/K.pdf');
    disk.attachmentSize.mockResolvedValue(null);
    await expect(messagingService.attachment(7, 20)).rejects.toMatchObject({
      statusCode: 404,
      code: 'attachment_missing',
    });
  });

  it('devolve caminho, tipo e Content-Disposition (arquivo = download, imagem = inline)', async () => {
    mRepo.findAttachment.mockResolvedValue(row as never);
    disk.attachmentPath.mockReturnValue('/data/uploads/2026/09/K.pdf');
    disk.attachmentSize.mockResolvedValue(10);
    const file = await messagingService.attachment(7, 20);
    expect(file).toEqual({
      path: '/data/uploads/2026/09/K.pdf',
      mime: 'application/pdf',
      size: 10,
      disposition: `attachment; filename="briefing.pdf"; filename*=UTF-8''briefing.pdf`,
    });

    mRepo.findAttachment.mockResolvedValue({
      ...row,
      type: 'image',
      file_name: 'x.png',
      file_mime: 'image/png',
    } as never);
    const img = await messagingService.attachment(7, 10);
    expect(img.disposition.startsWith('inline;')).toBe(true);
  });
});

describe('notificationBody', () => {
  const base = { id: 1, conversationId: 1, senderId: 1, createdAt: '', removedAt: null };
  it('usa a legenda quando há; senão descreve o anexo', () => {
    expect(notificationBody({ ...base, type: 'text', content: 'oi', attachment: null })).toBe('oi');
    expect(
      notificationBody({ ...base, type: 'text', content: 'x'.repeat(130), attachment: null }),
    ).toHaveLength(118);
    expect(notificationBody({ ...base, type: 'image', content: '', attachment: null })).toBe(
      'Enviou uma imagem',
    );
    expect(
      notificationBody({
        ...base,
        type: 'file',
        content: '',
        attachment: {
          name: 'briefing.pdf',
          mime: 'application/pdf',
          size: 1,
          url: '',
          purgedAt: null,
          purgedReason: null,
        },
      }),
    ).toBe('Enviou o arquivo briefing.pdf');
  });
});
