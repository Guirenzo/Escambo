import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging.repository', () => ({
  messagingRepository: {
    getOrCreate: vi.fn(),
    listMessages: vi.fn(),
    insertMessage: vi.fn(),
    previousMessage: vi.fn(),
    findAttachment: vi.fn(),
    findWithContract: vi.fn(),
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
vi.mock('../reports/reports.repository', () => ({
  reportsRepository: { create: vi.fn() },
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
import { profilesRepository } from '../profiles/profiles.repository';
import { realtime } from '../../config/realtime';
import { reportsRepository } from '../reports/reports.repository';
import * as storage from './attachments.storage';

const mRepo = vi.mocked(messagingRepository);
const cRepo = vi.mocked(contractsRepository);
const disk = vi.mocked(storage);
const reports = vi.mocked(reportsRepository);
const profiles = vi.mocked(profilesRepository);

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
      signals: [],
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
      signals: [],
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

  it('mensagem com Pix e telefone sai sinalizada e entra sozinha na fila de denúncias (ADR 45)', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    const text = 'Me paga no pix: (47) 99999-0001';
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({ id: 3, sender_id: 20, content: text, off_platform: 'pix,phone' }),
    );
    reports.create.mockResolvedValue(9);

    const msg = await messagingService.send(1, 20, text);

    expect(mRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ signals: ['pix', 'phone'] }),
    );
    expect(reports.create).toHaveBeenCalledWith({
      reporterId: null,
      targetType: 'message',
      targetId: 3,
      imageUrl: null,
      reason: 'off_platform',
      description: 'Sinalizado automaticamente: Pix e telefone.',
    });
    expect(msg.signals).toEqual(['pix', 'phone']);
    expect(realtime.emitToContract).toHaveBeenCalledWith(
      1,
      'message:new',
      expect.objectContaining({ signals: ['pix', 'phone'] }),
    );

    // Mensagem limpa não vira denúncia; falha ao gravar a denúncia não derruba o envio.
    vi.clearAllMocks();
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 4, content: 'obrigado' }));
    await messagingService.send(1, 10, 'obrigado');
    expect(reports.create).not.toHaveBeenCalled();
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({ id: 5, content: 'chave pix', off_platform: 'pix' }),
    );
    reports.create.mockRejectedValue(new Error('db'));
    expect((await messagingService.send(1, 10, 'chave pix')).signals).toEqual(['pix']);
  });

  it('se gravar a mensagem falha, o erro sobe e ninguém é avisado: nem a sala, nem a outra parte, nem a fila de denúncias', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    const boom = new Error('db down');
    mRepo.insertMessage.mockRejectedValue(boom);

    // Texto com sinal de propósito: sem mensagem gravada não há o que denunciar.
    await expect(messagingService.send(1, 20, 'me paga no pix')).rejects.toBe(boom);

    expect(mRepo.insertMessage).toHaveBeenCalledWith({
      conversationId: 5,
      senderId: 20,
      content: 'me paga no pix',
      signals: ['pix'],
    });
    expect(reports.create).not.toHaveBeenCalled();
    expect(realtime.emitToContract).not.toHaveBeenCalled();
    expect(notificationsService.notify).not.toHaveBeenCalled();
    expect(mRepo.previousMessage).not.toHaveBeenCalled();
    expect(profiles.blendResponseTime).not.toHaveBeenCalled();
  });

  it('o que volta para quem enviou é a mensagem gravada; a sala recebe a mesma, com o contrato', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 41, sender_id: 10, content: 'bom dia' }));

    const msg = await messagingService.send(1, 10, 'bom dia');

    expect(msg).toEqual({
      id: 41,
      conversationId: 5,
      senderId: 10,
      type: 'text',
      content: 'bom dia',
      attachment: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      removedAt: null,
      signals: [],
    });
    expect(realtime.emitToContract).toHaveBeenCalledTimes(1);
    expect(realtime.emitToContract).toHaveBeenCalledWith(1, 'message:new', {
      ...msg,
      contractId: 1,
    });
    // Uma notificação só, para a outra parte (o freelancer) — nunca para quem enviou.
    expect(notificationsService.notify).toHaveBeenCalledTimes(1);
    expect(notificationsService.notify).toHaveBeenCalledWith(20, {
      type: 'chat_message',
      title: 'Nova mensagem',
      body: 'bom dia',
      data: { contractId: 1 },
    });
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
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'unsupported_file_type',
      message: 'Tipo de arquivo não aceito: envie JPG, PNG, GIF, WebP, PDF ou ZIP',
    });
    await expect(
      messagingService.sendAttachment(
        1,
        10,
        { buffer: Buffer.alloc(0), originalname: 'a.png' },
        null,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'empty_file',
      message: 'O arquivo está vazio',
    });
    expect(disk.saveAttachment).not.toHaveBeenCalled();
    expect(mRepo.insertMessage).not.toHaveBeenCalled();
    // Nem o contrato é consultado, nem a conversa aberta: o arquivo é conferido primeiro.
    expect(cRepo.findById).not.toHaveBeenCalled();
    expect(mRepo.getOrCreate).not.toHaveBeenCalled();
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

    // Um arquivo por mensagem: grava uma vez só, com o tipo que os bytes dizem.
    expect(disk.saveAttachment).toHaveBeenCalledTimes(1);
    expect(disk.saveAttachment).toHaveBeenCalledWith(PNG, {
      mime: 'image/png',
      ext: 'png',
      kind: 'image',
      names: ['png'],
    });
    expect(mRepo.insertMessage).toHaveBeenCalledTimes(1);
    expect(mRepo.insertMessage).toHaveBeenCalledWith({
      conversationId: 5,
      senderId: 20,
      content: 'olha o rascunho',
      signals: [],
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
    expect(notificationsService.notify).not.toHaveBeenCalled();
    expect(reports.create).not.toHaveBeenCalled();
  });

  it('o arquivo vai para o disco ANTES da linha no banco; se o disco falhar, nenhuma linha é gravada e ninguém é avisado', async () => {
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({ id: 14, type: 'image', content: null, file_url: '2026/09/01KEY.png' }),
    );
    await messagingService.sendAttachment(1, 10, { buffer: PNG, originalname: 'a.png' }, null);
    expect(disk.saveAttachment.mock.invocationCallOrder[0]!).toBeLessThan(
      mRepo.insertMessage.mock.invocationCallOrder[0]!,
    );
    // Deu tudo certo: o arquivo gravado fica.
    expect(disk.removeAttachment).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    disk.saveAttachment.mockRejectedValue(full);

    await expect(
      messagingService.sendAttachment(1, 10, { buffer: PNG, originalname: 'a.png' }, null),
    ).rejects.toBe(full);

    expect(mRepo.insertMessage).not.toHaveBeenCalled();
    expect(realtime.emitToContract).not.toHaveBeenCalled();
    expect(notificationsService.notify).not.toHaveBeenCalled();
  });

  it('PDF entra como arquivo (não imagem), com o tipo e o tamanho reais, e a notificação diz o nome dele', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj');
    disk.saveAttachment.mockResolvedValue('2026/09/01KEY.pdf');
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({
        id: 15,
        sender_id: 10,
        type: 'file',
        content: null,
        file_url: '2026/09/01KEY.pdf',
        file_name: 'briefing.pdf',
        file_mime: 'application/pdf',
        file_size_bytes: pdf.length,
      }),
    );

    // O Content-Type declarado pelo cliente nem chega aqui: vale o que os bytes dizem.
    const msg = await messagingService.sendAttachment(
      1,
      10,
      { buffer: pdf, originalname: 'briefing.pdf' },
      null,
    );

    expect(disk.saveAttachment).toHaveBeenCalledWith(
      pdf,
      expect.objectContaining({ mime: 'application/pdf', ext: 'pdf', kind: 'file' }),
    );
    expect(mRepo.insertMessage).toHaveBeenCalledWith({
      conversationId: 5,
      senderId: 10,
      content: null,
      signals: [],
      attachment: {
        kind: 'file',
        key: '2026/09/01KEY.pdf',
        name: 'briefing.pdf',
        mime: 'application/pdf',
        size: pdf.length,
      },
    });
    expect(msg).toMatchObject({
      id: 15,
      type: 'file',
      content: '',
      attachment: { name: 'briefing.pdf', mime: 'application/pdf', size: pdf.length },
    });
    expect(realtime.emitToContract).toHaveBeenCalledWith(1, 'message:new', {
      ...msg,
      contractId: 1,
    });
    expect(notificationsService.notify).toHaveBeenCalledWith(20, {
      type: 'chat_message',
      title: 'Nova mensagem',
      body: 'Enviou o arquivo briefing.pdf',
      data: { contractId: 1 },
    });
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
    expect(img).toEqual({
      path: '/data/uploads/2026/09/K.pdf',
      mime: 'image/png',
      size: 10,
      disposition: `inline; filename="x.png"; filename*=UTF-8''x.png`,
    });
    // As duas partes da conversa baixam; o caminho vem da chave gravada, o tamanho do disco.
    expect(mRepo.findAttachment).toHaveBeenCalledWith(7);
    expect(disk.attachmentPath).toHaveBeenCalledWith('2026/09/K.pdf');
    expect(disk.attachmentSize).toHaveBeenCalledWith('2026/09/K.pdf');
    expect(mRepo.markPurged).not.toHaveBeenCalled();
  });
});

describe('notificationBody', () => {
  const base = {
    id: 1,
    conversationId: 1,
    senderId: 1,
    createdAt: '',
    removedAt: null,
    signals: [],
  };
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

  it('texto de até 120 caracteres vai inteiro; acima disso, 117 caracteres e reticências', () => {
    const exact = 'a'.repeat(120);
    expect(notificationBody({ ...base, type: 'text', content: exact, attachment: null })).toBe(
      exact,
    );
    expect(
      notificationBody({ ...base, type: 'text', content: `${exact}b`, attachment: null }),
    ).toBe(`${'a'.repeat(117)}…`);
    // Os espaços das pontas não contam nem aparecem.
    expect(notificationBody({ ...base, type: 'text', content: '  oi  ', attachment: null })).toBe(
      'oi',
    );
  });

  it('arquivo sem os dados do anexo não deixa espaço sobrando no texto', () => {
    expect(notificationBody({ ...base, type: 'file', content: '   ', attachment: null })).toBe(
      'Enviou o arquivo',
    );
  });
});

describe('messagingService: quem pode usar o chat do contrato', () => {
  it('contrato inexistente é 404 contract_not_found e quem não é parte é 403 forbidden — em histórico, texto e anexo —, sem abrir conversa nem gravar', async () => {
    const calls = [
      () => messagingService.history(1, 99),
      () => messagingService.send(1, 99, 'oi'),
      () => messagingService.sendAttachment(1, 99, { buffer: PNG, originalname: 'a.png' }, null),
    ];

    cRepo.findById.mockResolvedValue(undefined);
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        statusCode: 404,
        code: 'contract_not_found',
        message: 'Contratação não encontrada',
      });
    }
    cRepo.findById.mockResolvedValue(fakeContract());
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
        message: 'Você não participa desta contratação',
      });
    }

    expect(cRepo.findById).toHaveBeenCalledWith(1);
    expect(mRepo.getOrCreate).not.toHaveBeenCalled();
    expect(mRepo.listMessages).not.toHaveBeenCalled();
    expect(mRepo.insertMessage).not.toHaveBeenCalled();
    expect(disk.saveAttachment).not.toHaveBeenCalled();
    expect(realtime.emitToContract).not.toHaveBeenCalled();
    expect(notificationsService.notify).not.toHaveBeenCalled();
  });
});

describe('messagingService.history: o que cada mensagem mostra', () => {
  beforeEach(() => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
  });

  it('lê as 200 mensagens da conversa do contrato; para o freelancer, a outra parte é o cliente', async () => {
    mRepo.listMessages.mockResolvedValue([]);

    const h = await messagingService.history(1, 20);

    expect(mRepo.listMessages).toHaveBeenCalledWith(5, 200);
    expect(h).toEqual({ conversationId: 5, contractId: 1, otherPartyId: 10, messages: [] });
  });

  it('mensagem removida pela moderação sai sem o texto, sem o anexo e sem os sinais — só o aviso (ADR 44)', async () => {
    mRepo.listMessages.mockResolvedValue([
      fakeMsg({
        id: 8,
        type: 'file',
        content: 'me chama no zap',
        file_url: '2026/09/K.pdf',
        file_name: 'contato.pdf',
        file_mime: 'application/pdf',
        file_size_bytes: 99,
        off_platform: 'whatsapp',
        removed_at: new Date('2026-09-10T12:00:00Z'),
      }),
    ]);

    const h = await messagingService.history(1, 10);

    expect(h.messages[0]).toEqual({
      id: 8,
      conversationId: 5,
      senderId: 10,
      type: 'file',
      content: '',
      attachment: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      removedAt: '2026-09-10T12:00:00.000Z',
      signals: [],
    });
  });

  it('anexo expurgado continua na conversa, dizendo quando e por que o arquivo saiu (ADR 31)', async () => {
    mRepo.listMessages.mockResolvedValue([
      fakeMsg({
        id: 9,
        type: 'file',
        content: null,
        file_url: '2026/03/K.pdf',
        file_name: 'briefing.pdf',
        file_mime: 'application/pdf',
        file_size_bytes: 4321,
        file_purged_at: new Date('2026-09-14T15:00:00Z'),
        file_purged_reason: 'retention',
      }),
    ]);

    const h = await messagingService.history(1, 10);

    expect(h.messages[0]!.attachment).toEqual({
      name: 'briefing.pdf',
      mime: 'application/pdf',
      size: 4321,
      url: '/api/messaging/attachments/9',
      purgedAt: '2026-09-14T15:00:00.000Z',
      purgedReason: 'retention',
    });
  });

  it('anexo antigo sem nome, tipo ou tamanho gravados ganha os valores neutros; mensagem de sistema sai como texto', async () => {
    mRepo.listMessages.mockResolvedValue([
      fakeMsg({ id: 10, type: 'file', content: null, file_url: 'k.bin' }),
      fakeMsg({ id: 11, type: 'system', content: 'Contratação aceita', off_platform: 'pix,nada' }),
    ]);

    const h = await messagingService.history(1, 10);

    expect(h.messages[0]!.attachment).toEqual({
      name: 'arquivo',
      mime: 'application/octet-stream',
      size: 0,
      url: '/api/messaging/attachments/10',
      purgedAt: null,
      purgedReason: null,
    });
    expect(h.messages[1]).toMatchObject({ type: 'text', content: 'Contratação aceita' });
    // Só sinal conhecido chega à tela.
    expect(h.messages[1]!.signals).toEqual(['pix']);
  });
});

describe('messagingService.send: responsividade do freelancer (Escambo Score)', () => {
  const sentAt = new Date('2026-09-09T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: sentAt });
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
  });
  afterEach(() => vi.useRealTimers());

  it('quando o freelancer responde a uma mensagem do cliente, as horas até a resposta viram amostra do tempo médio DELE', async () => {
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 31, sender_id: 20, content: 'já vejo' }));
    mRepo.previousMessage.mockResolvedValue({
      sender_id: 10,
      created_at: new Date('2026-09-09T09:30:00Z'),
    });

    await messagingService.send(1, 20, 'já vejo');

    await vi.waitFor(() => expect(profiles.blendResponseTime).toHaveBeenCalledWith(20, 2.5));
    // A anterior é procurada na conversa do contrato, antes da mensagem que acabou de entrar.
    expect(mRepo.previousMessage).toHaveBeenCalledWith(5, 31);
    expect(profiles.blendResponseTime).toHaveBeenCalledTimes(1);
  });

  it('duas mensagens seguidas do freelancer não contam: a anterior não é do cliente', async () => {
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 32, sender_id: 20 }));
    mRepo.previousMessage.mockResolvedValue({ sender_id: 20, created_at: sentAt });

    await messagingService.send(1, 20, 'e mais uma coisa');

    await vi.waitFor(() => expect(mRepo.previousMessage).toHaveBeenCalledWith(5, 32));
    await new Promise((resolve) => setImmediate(resolve));
    expect(profiles.blendResponseTime).not.toHaveBeenCalled();
  });

  it('mensagem do cliente não mede nada: a responsividade é só do freelancer', async () => {
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 33, sender_id: 10 }));

    await messagingService.send(1, 10, 'oi');

    await new Promise((resolve) => setImmediate(resolve));
    expect(mRepo.previousMessage).not.toHaveBeenCalled();
    expect(profiles.blendResponseTime).not.toHaveBeenCalled();
  });

  it('anexo enviado pelo freelancer em resposta ao cliente também conta como resposta (vale para texto e anexo)', async () => {
    disk.saveAttachment.mockResolvedValue('2026/09/01KEY.png');
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({
        id: 35,
        sender_id: 20,
        type: 'image',
        content: null,
        file_url: '2026/09/01KEY.png',
      }),
    );
    mRepo.previousMessage.mockResolvedValue({
      sender_id: 10,
      created_at: new Date('2026-09-09T11:00:00Z'),
    });

    await messagingService.sendAttachment(1, 20, { buffer: PNG, originalname: 'a.png' }, null);

    await vi.waitFor(() => expect(profiles.blendResponseTime).toHaveBeenCalledWith(20, 1));
    expect(mRepo.previousMessage).toHaveBeenCalledWith(5, 35);
    expect(profiles.blendResponseTime).toHaveBeenCalledTimes(1);
  });

  it('primeira mensagem da conversa enviada pelo freelancer não é resposta a nada: não entra na média', async () => {
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 36, sender_id: 20 }));
    mRepo.previousMessage.mockResolvedValue(undefined);

    await messagingService.send(1, 20, 'olá, vi sua contratação');

    await vi.waitFor(() => expect(mRepo.previousMessage).toHaveBeenCalledWith(5, 36));
    await new Promise((resolve) => setImmediate(resolve));
    expect(profiles.blendResponseTime).not.toHaveBeenCalled();
  });

  it('falha ao registrar a responsividade não derruba o envio: a mensagem sai, é transmitida e notificada', async () => {
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ id: 34, sender_id: 20, content: 'ok' }));
    mRepo.previousMessage.mockRejectedValue(new Error('db'));

    const msg = await messagingService.send(1, 20, 'ok');

    expect(msg).toMatchObject({ id: 34, content: 'ok', senderId: 20 });
    expect(realtime.emitToContract).toHaveBeenCalledWith(1, 'message:new', {
      ...msg,
      contractId: 1,
    });
    expect(notificationsService.notify).toHaveBeenCalledWith(10, {
      type: 'chat_message',
      title: 'Nova mensagem',
      body: 'ok',
      data: { contractId: 1 },
    });
    await vi.waitFor(() => expect(mRepo.previousMessage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(profiles.blendResponseTime).not.toHaveBeenCalled();
  });
});

describe('messagingService.sendAttachment: legenda', () => {
  beforeEach(() => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    disk.saveAttachment.mockResolvedValue('2026/09/01KEY.png');
  });

  it('legenda com sinal de negociação por fora também entra na fila de denúncias (ADR 45)', async () => {
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({
        id: 12,
        type: 'image',
        content: 'chave pix na foto',
        file_url: '2026/09/01KEY.png',
        off_platform: 'pix',
      }),
    );
    reports.create.mockResolvedValue(3);

    const msg = await messagingService.sendAttachment(
      1,
      10,
      { buffer: PNG, originalname: 'a.png' },
      'chave pix na foto',
    );

    expect(mRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'chave pix na foto', signals: ['pix'] }),
    );
    expect(reports.create).toHaveBeenCalledWith({
      reporterId: null,
      targetType: 'message',
      targetId: 12,
      imageUrl: null,
      reason: 'off_platform',
      description: 'Sinalizado automaticamente: Pix.',
    });
    expect(msg.signals).toEqual(['pix']);
  });

  it('legenda só de espaços é gravada como ausente, e não gera denúncia', async () => {
    mRepo.insertMessage.mockResolvedValue(
      fakeMsg({ id: 13, type: 'image', content: null, file_url: '2026/09/01KEY.png' }),
    );

    await messagingService.sendAttachment(1, 10, { buffer: PNG, originalname: 'a.png' }, '   ');

    expect(mRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: null, signals: [] }),
    );
    expect(reports.create).not.toHaveBeenCalled();
  });
});

describe('messagingService.attachment: quando o arquivo não pode sair', () => {
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

  it('procura o anexo da mensagem pedida e recusa com os códigos attachment_not_found e forbidden', async () => {
    mRepo.findAttachment.mockResolvedValue(undefined);
    await expect(messagingService.attachment(7, 10)).rejects.toMatchObject({
      statusCode: 404,
      code: 'attachment_not_found',
    });
    expect(mRepo.findAttachment).toHaveBeenCalledWith(7);

    mRepo.findAttachment.mockResolvedValue(row as never);
    await expect(messagingService.attachment(7, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
    });
    expect(disk.attachmentPath).not.toHaveBeenCalled();
  });

  it('anexo de mensagem removida pela moderação é 410 message_removed para as partes (ADR 44) — e quem é de fora continua no 403', async () => {
    mRepo.findAttachment.mockResolvedValue({
      ...row,
      removed_at: new Date('2026-09-10T12:00:00Z'),
    } as never);

    await expect(messagingService.attachment(7, 10)).rejects.toMatchObject({
      statusCode: 410,
      code: 'message_removed',
      message: 'Esta mensagem foi removida pela moderação',
    });
    await expect(messagingService.attachment(7, 99)).rejects.toMatchObject({ statusCode: 403 });
    expect(disk.attachmentPath).not.toHaveBeenCalled();
  });

  it('mensagem removida E com o arquivo já expurgado: vale a remoção pela moderação (message_removed), não o expurgo', async () => {
    mRepo.findAttachment.mockResolvedValue({
      ...row,
      removed_at: new Date('2026-09-10T12:00:00Z'),
      file_purged_at: new Date('2026-09-14T15:00:00Z'),
      file_purged_reason: 'retention',
    } as never);

    await expect(messagingService.attachment(7, 20)).rejects.toMatchObject({
      statusCode: 410,
      code: 'message_removed',
    });
    expect(mRepo.markPurged).not.toHaveBeenCalled();
  });

  it('quem não é da conversa não fica sabendo se o anexo foi expurgado ou sumiu: é sempre 403, sem marcar nada', async () => {
    mRepo.findAttachment.mockResolvedValue({
      ...row,
      file_purged_at: new Date('2026-09-14T15:00:00Z'),
      file_purged_reason: 'lgpd',
    } as never);
    await expect(messagingService.attachment(7, 99)).rejects.toMatchObject({
      statusCode: 403,
      code: 'forbidden',
      message: 'Você não participa desta conversa',
    });

    mRepo.findAttachment.mockResolvedValue(row as never);
    disk.attachmentPath.mockReturnValue('/data/uploads/2026/09/K.pdf');
    disk.attachmentSize.mockResolvedValue(null);
    await expect(messagingService.attachment(7, 99)).rejects.toMatchObject({ statusCode: 403 });

    expect(disk.attachmentSize).not.toHaveBeenCalled();
    expect(mRepo.markPurged).not.toHaveBeenCalled();
  });

  it('anexo expurgado é 410 attachment_purged, com a explicação do motivo (ADR 31), sem olhar o disco', async () => {
    const purgedAt = new Date('2026-09-14T15:00:00Z');
    const cases = [
      ['retention', 'Este anexo foi removido pela política de retenção'],
      ['lgpd', 'Este anexo foi removido a pedido do titular'],
      ['missing', 'O arquivo deste anexo não está mais disponível'],
      // Linha expurgada sem motivo gravado: trata como arquivo indisponível.
      [null, 'O arquivo deste anexo não está mais disponível'],
    ] as const;

    for (const [reason, message] of cases) {
      mRepo.findAttachment.mockResolvedValue({
        ...row,
        file_purged_at: purgedAt,
        file_purged_reason: reason,
      } as never);
      await expect(messagingService.attachment(7, 20)).rejects.toMatchObject({
        statusCode: 410,
        code: 'attachment_purged',
        message,
      });
    }
    expect(disk.attachmentPath).not.toHaveBeenCalled();
    expect(disk.attachmentSize).not.toHaveBeenCalled();
    expect(mRepo.markPurged).not.toHaveBeenCalled();
  });

  it('arquivo que sumiu do disco: 404 attachment_missing, e a mensagem fica marcada como expurgada por "missing"', async () => {
    mRepo.findAttachment.mockResolvedValue(row as never);
    disk.attachmentPath.mockReturnValue('/data/uploads/2026/09/K.pdf');
    disk.attachmentSize.mockResolvedValue(null);

    await expect(messagingService.attachment(7, 20)).rejects.toMatchObject({
      statusCode: 404,
      code: 'attachment_missing',
      message: 'O arquivo deste anexo não está mais disponível',
    });

    expect(disk.attachmentPath).toHaveBeenCalledWith('2026/09/K.pdf');
    expect(disk.attachmentSize).toHaveBeenCalledWith('2026/09/K.pdf');
    expect(mRepo.markPurged).toHaveBeenCalledWith(7, 'missing');
  });

  it('chave que aponta para fora da pasta de uploads nunca é servida: 404, sem nem consultar o disco', async () => {
    mRepo.findAttachment.mockResolvedValue({ ...row, file_url: '../../etc/passwd' } as never);
    disk.attachmentPath.mockReturnValue(null);

    await expect(messagingService.attachment(7, 20)).rejects.toMatchObject({
      statusCode: 404,
      code: 'attachment_missing',
    });

    expect(disk.attachmentPath).toHaveBeenCalledWith('../../etc/passwd');
    expect(disk.attachmentSize).not.toHaveBeenCalled();
    expect(mRepo.markPurged).toHaveBeenCalledWith(7, 'missing');
  });

  it('se nem a marcação de expurgo der certo, a resposta continua sendo o 404 e a falha da marcação fica tratada (melhor esforço)', async () => {
    mRepo.findAttachment.mockResolvedValue(row as never);
    disk.attachmentPath.mockReturnValue('/data/uploads/2026/09/K.pdf');
    disk.attachmentSize.mockResolvedValue(null);
    // Promessa rejeitada de verdade, e vigiada: a rejeição criada pelo mockRejectedValue já nasce
    // "tratada" pelo próprio mock, então com ela o teste passaria mesmo se o service largasse a
    // falha solta — e rejeição sem tratamento encerra a API (server.ts, unhandledRejection).
    const failure = Promise.reject(new Error('db'));
    const handled = vi.spyOn(failure, 'catch');
    mRepo.markPurged.mockReturnValueOnce(failure);

    await expect(messagingService.attachment(7, 20)).rejects.toMatchObject({
      statusCode: 404,
      code: 'attachment_missing',
    });

    expect(mRepo.markPurged).toHaveBeenCalledWith(7, 'missing');
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(expect.any(Function));
    // Tratada de fato: o que sobra da marcação que falhou é uma promessa resolvida.
    await expect(handled.mock.results[0]!.value).resolves.toBeUndefined();
  });

  it('anexo antigo sem nome nem tipo gravados baixa como "arquivo", em application/octet-stream, com o tamanho do disco', async () => {
    mRepo.findAttachment.mockResolvedValue({
      ...row,
      file_name: null,
      file_mime: null,
      file_size_bytes: null,
    } as never);
    disk.attachmentPath.mockReturnValue('/data/uploads/2026/09/K.pdf');
    disk.attachmentSize.mockResolvedValue(77);

    expect(await messagingService.attachment(7, 10)).toEqual({
      path: '/data/uploads/2026/09/K.pdf',
      mime: 'application/octet-stream',
      size: 77,
      disposition: `attachment; filename="arquivo"; filename*=UTF-8''arquivo`,
    });
    expect(mRepo.markPurged).not.toHaveBeenCalled();
  });
});

describe('messagingService.announceChange (moderação, ADR 44)', () => {
  it('avisa a sala do contrato da mensagem com a versão atual dela: removida vai sem texto e sem anexo', async () => {
    mRepo.findWithContract.mockResolvedValue({
      ...fakeMsg({
        id: 31,
        content: 'me paga por fora',
        off_platform: 'off_platform',
        removed_at: new Date('2026-09-10T12:00:00Z'),
      }),
      contract_id: 3,
    } as never);

    await messagingService.announceChange(31);

    expect(mRepo.findWithContract).toHaveBeenCalledWith(31);
    expect(realtime.emitToContract).toHaveBeenCalledTimes(1);
    expect(realtime.emitToContract).toHaveBeenCalledWith(3, 'message:updated', {
      id: 31,
      conversationId: 5,
      senderId: 10,
      type: 'text',
      content: '',
      attachment: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      removedAt: '2026-09-10T12:00:00.000Z',
      signals: [],
      contractId: 3,
    });
  });

  it('mensagem devolvida numa contestação aceita volta para a sala com o texto e os sinais', async () => {
    mRepo.findWithContract.mockResolvedValue({
      ...fakeMsg({ id: 31, content: 'chave pix', off_platform: 'pix', removed_at: null }),
      contract_id: 3,
    } as never);

    await messagingService.announceChange(31);

    expect(realtime.emitToContract).toHaveBeenCalledWith(
      3,
      'message:updated',
      expect.objectContaining({ content: 'chave pix', removedAt: null, signals: ['pix'] }),
    );
  });

  it('mensagem que não existe, ou de conversa sem contrato, não avisa ninguém', async () => {
    mRepo.findWithContract.mockResolvedValue(undefined);
    await messagingService.announceChange(404);

    mRepo.findWithContract.mockResolvedValue({
      ...fakeMsg({ id: 31 }),
      contract_id: null,
    } as never);
    await messagingService.announceChange(31);

    expect(mRepo.findWithContract).toHaveBeenCalledTimes(2);
    expect(realtime.emitToContract).not.toHaveBeenCalled();
  });
});
