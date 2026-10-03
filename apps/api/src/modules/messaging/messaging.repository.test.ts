import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { messagingRepository } from './messaging.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository do chat sem banco: o que cada método pede (tabela, filtro, ordem, limite, parâmetros)
 * e o que faz com a resposta. Se o SQL roda no MySQL é assunto da integração.
 */

/**
 * O que uma mensagem precisa trazer do banco para a tela: quem, quando, o texto, o anexo (ADR 29),
 * o expurgo do arquivo (ADR 31), a remoção pela moderação (ADR 44) e os sinais (ADR 45).
 */
const MESSAGE_FIELDS = [
  'id',
  'conversation_id',
  'sender_id',
  'type',
  'content',
  'created_at',
  'file_url',
  'file_name',
  'file_mime',
  'file_size_bytes',
  'file_purged_at',
  'file_purged_reason',
  'removed_at',
  'off_platform',
].sort();

/** As colunas pedidas no SELECT até `until`, em ordem alfabética (a ordem no SQL não importa). */
const selected = (sql: string, until: string): string[] =>
  sql.slice('SELECT '.length, sql.indexOf(until)).split(', ').sort();

describe('messagingRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('getOrCreate', () => {
    it('a conversa é única por par: os participantes vão ordenados (menor primeiro), venha na ordem que vier', async () => {
      fakeDb.reply({ insertId: 5, affectedRows: 1 }, { insertId: 5, affectedRows: 0 });

      expect(await messagingRepository.getOrCreate(20, 10, 3)).toBe(5);
      expect(await messagingRepository.getOrCreate(10, 20, 3)).toBe(5);

      expect(fakeDb.calls[0]!.params).toEqual({ contractId: 3, a: 10, b: 20 });
      expect(fakeDb.calls[1]!.params).toEqual({ contractId: 3, a: 10, b: 20 });
    });

    it('é UMA instrução: o duplicado devolve o id que já existe e só preenche o contrato que faltava', async () => {
      fakeDb.reply({ insertId: 8, affectedRows: 2 });

      expect(await messagingRepository.getOrCreate(7, 7, 4)).toBe(8);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'INSERT INTO conversations (contract_id, participant_a, participant_b) VALUES (:contractId, :a, :b)',
      );
      expect(sql).toContain('ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)');
      // Conversa que já tem contrato fica com o dela.
      expect(sql).toContain('contract_id = COALESCE(contract_id, :contractId)');
      expect(params).toEqual({ contractId: 4, a: 7, b: 7 });
    });
  });

  it('previousMessage: a mensagem imediatamente anterior, na mesma conversa (ou undefined)', async () => {
    const previous = { sender_id: 10, created_at: new Date('2026-09-09T09:30:00Z') };
    fakeDb.reply([previous, { sender_id: 99, created_at: new Date(0) }], []);

    expect(await messagingRepository.previousMessage(5, 31)).toBe(previous);
    expect(await messagingRepository.previousMessage(5, 1)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      'SELECT sender_id, created_at FROM messages WHERE conversation_id = :conversationId AND id < :beforeId ORDER BY id DESC LIMIT 1',
    );
    expect(params).toEqual({ conversationId: 5, beforeId: 31 });
    expect(fakeDb.calls[1]!.params).toEqual({ conversationId: 5, beforeId: 1 });
  });

  it('listMessages: só as mensagens da conversa, da mais antiga para a mais nova, até o limite', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    fakeDb.reply(rows);

    expect(await messagingRepository.listMessages(5, 200)).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'FROM messages WHERE conversation_id = :conversationId ORDER BY id ASC LIMIT 200',
    );
    // O histórico precisa da remoção pela moderação (ADR 44), dos sinais (ADR 45) e do expurgo (ADR 31).
    for (const column of ['removed_at', 'off_platform', 'file_purged_at', 'file_purged_reason']) {
      expect(sql).toContain(column);
    }
    // Nenhum campo da mensagem fica de fora (o histórico monta a bolha inteira a partir daqui).
    expect(selected(sql, ' FROM messages')).toEqual(MESSAGE_FIELDS);
    expect(params).toEqual({ conversationId: 5 });
  });

  it('listMessages: conversa sem mensagem devolve lista vazia, e o limite pedido é o que vai no SQL', async () => {
    expect(await messagingRepository.listMessages(9, 50)).toEqual([]);

    expect(fakeDb.calls[0]!.sql.endsWith('ORDER BY id ASC LIMIT 50')).toBe(true);
    expect(fakeDb.calls[0]!.params).toEqual({ conversationId: 9 });
  });

  describe('insertMessage', () => {
    it('texto: grava como "text" sem campos de arquivo, marca a conversa e devolve a linha gravada', async () => {
      const saved = { id: 31, content: 'oi' };
      fakeDb.reply({ insertId: 31, affectedRows: 1 }, { affectedRows: 1 }, [saved]);

      const row = await messagingRepository.insertMessage({
        conversationId: 5,
        senderId: 10,
        content: 'oi',
        signals: [],
      });

      expect(row).toBe(saved);
      expect(fakeDb.calls).toHaveLength(3);
      expect(fakeDb.calls[0]!.sql).toContain(
        'INSERT INTO messages (conversation_id, sender_id, type, content, file_url, file_name, file_mime, file_size_bytes, off_platform)',
      );
      // Cada valor na coluna dele: a ordem dos VALUES acompanha a das colunas.
      expect(fakeDb.calls[0]!.sql).toContain(
        'VALUES (:conversationId, :senderId, :type, :content, :fileKey, :fileName, :fileMime, :fileSize, :offPlatform)',
      );
      expect(fakeDb.calls[0]!.params).toEqual({
        conversationId: 5,
        senderId: 10,
        type: 'text',
        content: 'oi',
        fileKey: null,
        fileName: null,
        fileMime: null,
        fileSize: null,
        offPlatform: null,
      });
      // A conversa sobe na lista: last_message_at é da conversa da mensagem.
      expect(fakeDb.calls[1]!.sql).toBe(
        'UPDATE conversations SET last_message_at = NOW() WHERE id = :conversationId',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ conversationId: 5 });
      // O que volta é a linha relida pelo id gerado (com created_at do banco).
      expect(fakeDb.calls[2]!.sql.endsWith(' FROM messages WHERE id = :id')).toBe(true);
      expect(selected(fakeDb.calls[2]!.sql, ' FROM messages')).toEqual(MESSAGE_FIELDS);
      expect(fakeDb.calls[2]!.params).toEqual({ id: 31 });
    });

    it('imagem: o tipo gravado é "image" (é o que faz o anexo abrir na conversa em vez de baixar)', async () => {
      fakeDb.reply({ insertId: 34, affectedRows: 1 }, { affectedRows: 1 }, [{ id: 34 }]);

      await messagingRepository.insertMessage({
        conversationId: 5,
        senderId: 10,
        content: 'olha o rascunho',
        signals: [],
        attachment: {
          kind: 'image',
          key: '2026/09/01KEY.png',
          name: 'rascunho.png',
          mime: 'image/png',
          size: 32,
        },
      });

      expect(fakeDb.calls[0]!.params).toEqual({
        conversationId: 5,
        senderId: 10,
        type: 'image',
        content: 'olha o rascunho',
        fileKey: '2026/09/01KEY.png',
        fileName: 'rascunho.png',
        fileMime: 'image/png',
        fileSize: 32,
        offPlatform: null,
      });
    });

    it('se marcar a conversa falha, o erro sobe e nada é relido (quem chamou desfaz o arquivo)', async () => {
      const boom = new Error('ER_LOCK_WAIT_TIMEOUT');
      fakeDb.reply({ insertId: 35, affectedRows: 1 }, boom);

      await expect(
        messagingRepository.insertMessage({
          conversationId: 5,
          senderId: 10,
          content: 'oi',
          signals: [],
        }),
      ).rejects.toBe(boom);

      expect(fakeDb.sqls().map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual([
        'INSERT INTO messages',
        'UPDATE conversations SET',
      ]);
    });

    it('anexo: o tipo é o do arquivo (image/file), com chave, nome, mime e tamanho; a legenda pode ser nula (ADR 29)', async () => {
      fakeDb.reply({ insertId: 32, affectedRows: 1 }, { affectedRows: 1 }, [{ id: 32 }]);

      await messagingRepository.insertMessage({
        conversationId: 5,
        senderId: 20,
        content: null,
        signals: [],
        attachment: {
          kind: 'file',
          key: '2026/09/01KEY.pdf',
          name: 'briefing.pdf',
          mime: 'application/pdf',
          size: 4321,
        },
      });

      expect(fakeDb.calls[0]!.params).toEqual({
        conversationId: 5,
        senderId: 20,
        type: 'file',
        content: null,
        fileKey: '2026/09/01KEY.pdf',
        fileName: 'briefing.pdf',
        fileMime: 'application/pdf',
        fileSize: 4321,
        offPlatform: null,
      });
    });

    it('os sinais de negociação por fora são gravados juntos, separados por vírgula (ADR 45)', async () => {
      fakeDb.reply({ insertId: 33, affectedRows: 1 }, { affectedRows: 1 }, [{ id: 33 }]);

      await messagingRepository.insertMessage({
        conversationId: 5,
        senderId: 20,
        content: 'me paga no pix (47) 99999-0001',
        signals: ['pix', 'phone'],
        attachment: null,
      });

      expect(fakeDb.calls[0]!.params).toMatchObject({ type: 'text', offPlatform: 'pix,phone' });
    });

    it('se o INSERT falha, a conversa não é marcada e o erro sobe', async () => {
      const boom = new Error('ER_NO_REFERENCED_ROW');
      fakeDb.reply(boom);

      await expect(
        messagingRepository.insertMessage({
          conversationId: 5,
          senderId: 10,
          content: 'oi',
          signals: [],
        }),
      ).rejects.toBe(boom);
      expect(fakeDb.calls).toHaveLength(1);
    });
  });

  describe('setRemoved (moderação, ADR 44)', () => {
    const conn = fakeDb.conn as unknown as PoolConnection;

    it('remover só pega mensagem no ar, e devolver só pega mensagem removida', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

      expect(await messagingRepository.setRemoved(conn, 31, true)).toBe(true);
      expect(await messagingRepository.setRemoved(conn, 31, false)).toBe(true);

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE messages SET removed_at = NOW() WHERE id = :id AND removed_at IS NULL',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 31 });
      expect(fakeDb.calls[1]!.sql).toBe(
        'UPDATE messages SET removed_at = NULL WHERE id = :id AND removed_at IS NOT NULL',
      );
      expect(fakeDb.calls[1]!.params).toEqual({ id: 31 });
    });

    it('quando nada muda (já estava removida, ou não existe), devolve false', async () => {
      fakeDb.reply({ affectedRows: 0 });
      expect(await messagingRepository.setRemoved(conn, 31, true)).toBe(false);
    });

    it('roda na conexão da transação de quem chamou, sem abrir nem fechar transação', async () => {
      // Uma conexão só deste teste: se o UPDATE fosse pelo pool, sairia da transação da moderação
      // (e ficaria gravado mesmo com o rollback de quem chamou).
      const query = vi.fn(async () => [{ affectedRows: 1 }, []]);
      const own = { query } as unknown as PoolConnection;

      expect(await messagingRepository.setRemoved(own, 31, true)).toBe(true);

      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE messages SET removed_at'),
        {
          id: 31,
        },
      );
      expect(fakeDb.calls).toHaveLength(0);
      expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
      expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
      expect(fakeDb.conn.commit).not.toHaveBeenCalled();
      expect(fakeDb.conn.release).not.toHaveBeenCalled();
    });

    it('devolver uma mensagem que não estava removida também não muda nada: false', async () => {
      fakeDb.reply({ affectedRows: 0 });
      expect(await messagingRepository.setRemoved(conn, 31, false)).toBe(false);
      expect(fakeDb.calls).toHaveLength(1);
    });

    it('se o UPDATE falha, o erro sobe para quem abriu a transação desfazer', async () => {
      const boom = new Error('deadlock');
      fakeDb.reply(boom);
      await expect(messagingRepository.setRemoved(conn, 31, true)).rejects.toBe(boom);
      expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
    });
  });

  it('findWithContract: a mensagem com o contrato da conversa DELA (para avisar a sala), ou undefined', async () => {
    const row = { id: 31, conversation_id: 5, contract_id: 3 };
    fakeDb.reply([row], []);

    expect(await messagingRepository.findWithContract(31)).toBe(row);
    expect(await messagingRepository.findWithContract(404)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      '(SELECT cv.contract_id FROM conversations cv WHERE cv.id = messages.conversation_id) AS contract_id',
    );
    expect(sql).toContain('FROM messages WHERE id = :id LIMIT 1');
    expect(sql).toContain('removed_at');
    // O aviso leva a mensagem inteira: as mesmas colunas do histórico, mais o contrato.
    expect(selected(sql, ', (SELECT cv.contract_id')).toEqual(MESSAGE_FIELDS);
    expect(params).toEqual({ id: 31 });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 404 });
  });

  it('findAttachment: só mensagem que TEM arquivo, com as duas partes da conversa (quem pode baixar)', async () => {
    const row = { id: 7, file_url: '2026/09/K.pdf', participant_a: 10, participant_b: 20 };
    fakeDb.reply([row], []);

    expect(await messagingRepository.findAttachment(7)).toBe(row);
    expect(await messagingRepository.findAttachment(8)).toBeUndefined();

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('FROM messages m JOIN conversations cv ON cv.id = m.conversation_id');
    expect(sql).toContain('WHERE m.id = :messageId AND m.file_url IS NOT NULL LIMIT 1');
    for (const column of [
      'cv.participant_a',
      'cv.participant_b',
      'm.removed_at',
      'm.file_purged_at',
      'm.file_purged_reason',
      'm.file_mime',
      'm.file_name',
      // A chave do arquivo no disco e o tipo (imagem abre na tela, arquivo baixa).
      'm.file_url',
      'm.type',
    ]) {
      expect(sql).toContain(column);
    }
    // Tudo o que o download usa, e só isso: o texto da mensagem não vem junto.
    expect(selected(sql, ' FROM messages m')).toEqual(
      [
        'm.id',
        'm.type',
        'm.file_url',
        'm.file_name',
        'm.file_mime',
        'm.file_size_bytes',
        'm.file_purged_at',
        'm.file_purged_reason',
        'm.removed_at',
        'cv.participant_a',
        'cv.participant_b',
      ].sort(),
    );
    expect(params).toEqual({ messageId: 7 });
    expect(fakeDb.calls[1]!.params).toEqual({ messageId: 8 });
  });

  it('as leituras não engolem falha do banco: o erro sobe para quem chamou', async () => {
    const boom = new Error('ECONNREFUSED');
    fakeDb.reply(boom, boom, boom, boom);

    await expect(messagingRepository.getOrCreate(10, 20, 3)).rejects.toBe(boom);
    await expect(messagingRepository.listMessages(5, 200)).rejects.toBe(boom);
    await expect(messagingRepository.findAttachment(7)).rejects.toBe(boom);
    await expect(messagingRepository.findWithContract(31)).rejects.toBe(boom);

    // Uma tentativa por chamada, sem repetir a instrução.
    expect(fakeDb.calls).toHaveLength(4);
  });

  describe('expurgo de anexos (ADR 31)', () => {
    it('listPurgeable: anexo ainda no disco, anterior ao corte, e só de quem NÃO tem contratação aberta entre si', async () => {
      const rows = [
        { id: 1, file_url: '2026/03/a.png' },
        { id: 2, file_url: '2026/03/b.pdf' },
      ];
      fakeDb.reply(rows);
      const cutoff = new Date('2026-03-18T15:00:00Z');

      expect(await messagingRepository.listPurgeable(cutoff, 500)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain('SELECT m.id, m.file_url FROM messages m');
      expect(sql).toContain('JOIN conversations cv ON cv.id = m.conversation_id');
      expect(sql).toContain(
        'WHERE m.has_file = 1 AND m.file_purged_at IS NULL AND m.created_at < :cutoff',
      );
      expect(sql).toContain('AND NOT EXISTS ( SELECT 1 FROM contracts c');
      // O par vale nos dois sentidos: qualquer um dos dois pode ser o cliente.
      expect(sql).toContain(
        '(c.client_id = cv.participant_a AND c.freelancer_id = cv.participant_b)',
      );
      expect(sql).toContain(
        'OR (c.client_id = cv.participant_b AND c.freelancer_id = cv.participant_a)',
      );
      // Contratação aberta = qualquer estado antes do fim (concluída, cancelada e recusada liberam).
      expect(sql).toContain(
        "AND c.status IN ('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')",
      );
      expect(sql).toContain('ORDER BY m.id LIMIT 500');
      expect(params).toEqual({ cutoff });
    });

    it('listPurgeable: o limite entra no SQL sempre como inteiro', async () => {
      await messagingRepository.listPurgeable(new Date(0), 50.9);
      expect(fakeDb.calls[0]!.sql.endsWith('ORDER BY m.id LIMIT 50')).toBe(true);
    });

    it('listUserAttachments (LGPD): só os anexos ENVIADOS pelo usuário que ainda estão no disco', async () => {
      const rows = [{ id: 4, file_url: '2026/09/x.png' }];
      fakeDb.reply(rows);

      expect(await messagingRepository.listUserAttachments(10)).toBe(rows);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT id, file_url FROM messages WHERE sender_id = :userId AND has_file = 1 AND file_purged_at IS NULL',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 10 });
    });

    it('markPurged: grava quando e por quê, sem sobrescrever um expurgo anterior', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(await messagingRepository.markPurged(7, 'retention')).toBeUndefined();

      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE messages SET file_purged_at = NOW(), file_purged_reason = :reason WHERE id = :id AND file_purged_at IS NULL',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 7, reason: 'retention' });
    });

    it('listAttachmentKeys: as chaves que ainda deveriam estar no disco, como texto', async () => {
      fakeDb.reply([{ file_url: '2026/09/a.png' }, { file_url: '2026/09/b.pdf' }]);

      expect(await messagingRepository.listAttachmentKeys()).toEqual([
        '2026/09/a.png',
        '2026/09/b.pdf',
      ]);

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT file_url FROM messages WHERE has_file = 1 AND file_purged_at IS NULL',
      );
      expect(fakeDb.calls[0]!.params).toBeUndefined();
    });

    it('listAttachmentKeys: o que vier do banco vira texto (a comparação com o disco é por chave exata), e sem anexos a lista é vazia', async () => {
      fakeDb.reply([{ file_url: Buffer.from('2026/09/c.zip') }], []);

      expect(await messagingRepository.listAttachmentKeys()).toEqual(['2026/09/c.zip']);
      expect(await messagingRepository.listAttachmentKeys()).toEqual([]);
    });

    it('listPurgeable e listUserAttachments: sem nada a expurgar, lista vazia', async () => {
      expect(await messagingRepository.listPurgeable(new Date(0), 500)).toEqual([]);
      expect(await messagingRepository.listUserAttachments(10)).toEqual([]);
      expect(fakeDb.calls).toHaveLength(2);
    });

    it('markPurged: o motivo gravado é o informado (retenção, LGPD ou arquivo sumido), e falha do banco sobe', async () => {
      const boom = new Error('db');
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 }, boom);

      await messagingRepository.markPurged(8, 'lgpd');
      await messagingRepository.markPurged(9, 'missing');
      await expect(messagingRepository.markPurged(10, 'retention')).rejects.toBe(boom);

      expect(fakeDb.calls.map((call) => call.params)).toEqual([
        { id: 8, reason: 'lgpd' },
        { id: 9, reason: 'missing' },
        { id: 10, reason: 'retention' },
      ]);
    });

    it('attachmentStats: conta só mensagens com arquivo e devolve números (o MySQL manda SUM como texto)', async () => {
      fakeDb.reply([{ active: '12', active_bytes: '34567', purged: '3', purged_30d: '1' }]);

      expect(await messagingRepository.attachmentStats()).toEqual({
        active: 12,
        activeBytes: 34567,
        purged: 3,
        purged30d: 1,
      });

      const { sql } = fakeDb.calls[0]!;
      expect(sql).toContain('FROM messages WHERE has_file = 1');
      expect(sql).toContain('COALESCE(SUM(file_purged_at IS NULL), 0) AS active');
      // Os bytes ativos não somam o que já saiu do disco.
      expect(sql).toContain(
        'COALESCE(SUM(CASE WHEN file_purged_at IS NULL THEN file_size_bytes END), 0) AS active_bytes',
      );
      expect(sql).toContain('COALESCE(SUM(file_purged_at IS NOT NULL), 0) AS purged');
      expect(sql).toContain(
        'COALESCE(SUM(file_purged_at >= NOW() - INTERVAL 30 DAY), 0) AS purged_30d',
      );
      // É uma leitura só, sem parâmetro.
      expect(fakeDb.calls).toHaveLength(1);
      expect(fakeDb.calls[0]!.params).toBeUndefined();
    });

    it('attachmentStats: sem nenhum anexo, tudo é zero (número, não texto nem nulo)', async () => {
      fakeDb.reply([{ active: '0', active_bytes: '0', purged: '0', purged_30d: '0' }]);

      expect(await messagingRepository.attachmentStats()).toStrictEqual({
        active: 0,
        activeBytes: 0,
        purged: 0,
        purged30d: 0,
      });
    });
  });
});
