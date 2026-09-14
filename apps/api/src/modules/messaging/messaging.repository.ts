import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';

export interface ConversationRow extends RowDataPacket {
  id: number;
  contract_id: number | null;
  participant_a: number;
  participant_b: number;
}

export type MessageRowType = 'text' | 'image' | 'file' | 'system';

export interface MessageRow extends RowDataPacket {
  id: number;
  conversation_id: number;
  sender_id: number;
  type: MessageRowType;
  content: string | null;
  /** Chave do anexo no armazenamento (DATA_DIR/uploads); NULL em mensagem de texto. */
  file_url: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  created_at: Date;
}

/** Anexo + quem pode lê-lo (as partes da conversa). */
export interface AttachmentRow extends RowDataPacket {
  id: number;
  type: MessageRowType;
  file_url: string;
  file_name: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  participant_a: number;
  participant_b: number;
}

export interface NewAttachment {
  key: string;
  name: string;
  mime: string;
  size: number;
}

const MESSAGE_COLUMNS = `id, conversation_id, sender_id, type, content, file_url, file_name, file_mime,
       file_size_bytes, created_at`;

/** Normaliza o par (a<b) para casar com a unique key uq_conversation. */
function orderPair(x: number, y: number): [number, number] {
  return x <= y ? [x, y] : [y, x];
}

export const messagingRepository = {
  /**
   * Retorna a conversa entre as duas partes (única por par), criando se não existir, e
   * associa o contrato quando a conversa ainda não tem um. É UMA instrução de propósito: ao
   * abrir a Sala, o histórico (REST) e o contract:join (socket) chegam juntos, e dois INSERT
   * concorrentes faziam o segundo tomar "Duplicate entry" (500). Com ON DUPLICATE KEY UPDATE
   * o duplicado vira "pega o id que já existe" (LAST_INSERT_ID(id)).
   */
  async getOrCreate(uidA: number, uidB: number, contractId: number): Promise<number> {
    const [a, b] = orderPair(uidA, uidB);
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO conversations (contract_id, participant_a, participant_b)
       VALUES (:contractId, :a, :b)
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id),
         contract_id = COALESCE(contract_id, :contractId)`,
      { contractId, a, b },
    );
    return res.insertId;
  },

  /** Mensagem imediatamente anterior a `beforeId` na conversa (para medir tempo de resposta). */
  async previousMessage(
    conversationId: number,
    beforeId: number,
  ): Promise<{ sender_id: number; created_at: Date } | undefined> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT sender_id, created_at FROM messages
        WHERE conversation_id = :conversationId AND id < :beforeId
        ORDER BY id DESC LIMIT 1`,
      { conversationId, beforeId },
    );
    return rows[0] as { sender_id: number; created_at: Date } | undefined;
  },

  async listMessages(conversationId: number, limit: number): Promise<MessageRow[]> {
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages
        WHERE conversation_id = :conversationId
        ORDER BY id ASC
        LIMIT ${limit}`,
      { conversationId },
    );
    return rows;
  },

  /** Insere texto (attachment null) ou imagem/arquivo (content = legenda opcional). */
  async insertMessage(data: {
    conversationId: number;
    senderId: number;
    content: string | null;
    attachment?: (NewAttachment & { kind: 'image' | 'file' }) | null;
  }): Promise<MessageRow> {
    const a = data.attachment ?? null;
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO messages (conversation_id, sender_id, type, content, file_url, file_name, file_mime, file_size_bytes)
       VALUES (:conversationId, :senderId, :type, :content, :fileKey, :fileName, :fileMime, :fileSize)`,
      {
        conversationId: data.conversationId,
        senderId: data.senderId,
        type: a ? a.kind : 'text',
        content: data.content,
        fileKey: a?.key ?? null,
        fileName: a?.name ?? null,
        fileMime: a?.mime ?? null,
        fileSize: a?.size ?? null,
      },
    );
    await pool.query<ResultSetHeader>(
      `UPDATE conversations SET last_message_at = NOW() WHERE id = :conversationId`,
      { conversationId: data.conversationId },
    );
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = :id`,
      { id: res.insertId },
    );
    return rows[0]!;
  },

  /** Anexo de uma mensagem com as partes da conversa (para checar quem pode baixar). */
  async findAttachment(messageId: number): Promise<AttachmentRow | undefined> {
    const [rows] = await pool.query<AttachmentRow[]>(
      `SELECT m.id, m.type, m.file_url, m.file_name, m.file_mime, m.file_size_bytes,
              cv.participant_a, cv.participant_b
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.id = :messageId AND m.file_url IS NOT NULL
        LIMIT 1`,
      { messageId },
    );
    return rows[0];
  },
};
