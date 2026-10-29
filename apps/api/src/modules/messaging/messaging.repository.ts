import type { OffPlatformSignal } from '@escambo/types';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';
import { serializeSignals } from './off-platform';

export interface ConversationRow extends RowDataPacket {
  id: number;
  contract_id: number | null;
  participant_a: number;
  participant_b: number;
}

export type MessageRowType = 'text' | 'image' | 'file' | 'system';
/** Por que o arquivo de um anexo saiu do disco (ADR 31). */
export type PurgeReason = 'retention' | 'lgpd' | 'missing';

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
  file_purged_at: Date | null;
  file_purged_reason: PurgeReason | null;
  created_at: Date;
  /** Removida pela moderação (ADR 44). */
  removed_at?: Date | null;
  /** Sinais de negociação por fora, "pix,phone" (ADR 45); NULL quando limpa. */
  off_platform?: string | null;
  /** Quando o destinatário leu (RF-059); NULL enquanto não lida. */
  read_at?: Date | null;
}

/** Anexo + quem pode lê-lo (as partes da conversa). */
export interface AttachmentRow extends RowDataPacket {
  id: number;
  type: MessageRowType;
  file_url: string;
  file_name: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  file_purged_at: Date | null;
  file_purged_reason: PurgeReason | null;
  removed_at?: Date | null;
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
       file_size_bytes, file_purged_at, file_purged_reason, created_at, removed_at, off_platform,
       read_at`;

/** Resultado de marcar como lidas: quantas mudaram agora, até qual id e com que horário. */
export type MarkReadResult =
  { marked: 0; upToId: null; readAt: null } | { marked: number; upToId: number; readAt: Date };

/**
 * Contratação que ainda não terminou: proposta pendente, aceita, em andamento, entregue, em revisão
 * ou em disputa. É a mesma lista que segura os anexos (ADR 31) e que mantém o chat aberto (RF-062).
 */
const OPEN_CONTRACT_STATUSES = `('pending', 'accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')`;
/** Troca proposta (à espera de resposta), aceita, em andamento ou em disputa (RF-062). */
const OPEN_BARTER_STATUSES = `('proposed', 'accepted', 'active', 'disputed')`;

/** Normaliza o par (a<b) para casar com a unique key uq_conversation. */
function orderPair(x: number, y: number): [number, number] {
  return x <= y ? [x, y] : [y, x];
}

export const messagingRepository = {
  /** A conversa atravessa contratos do mesmo par; consultar não cria nem vincula contrato. */
  async findByPair(uidA: number, uidB: number): Promise<ConversationRow | undefined> {
    const [a, b] = orderPair(uidA, uidB);
    const [rows] = await pool.query<ConversationRow[]>(
      `SELECT id, contract_id, participant_a, participant_b FROM conversations
        WHERE participant_a = :a AND participant_b = :b LIMIT 1`,
      { a, b },
    );
    return rows[0];
  },

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

  /**
   * Existe relação aberta entre as duas pessoas (RF-062)? Uma contratação que não terminou, em
   * qualquer direção, ou uma troca proposta ou em andamento. A conversa é uma só por par e atravessa
   * as contratações (ADR 31): basta uma relação aberta para escrever, em qualquer Sala do par.
   */
  async hasOpenRelation(uidA: number, uidB: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT (
          EXISTS (
            SELECT 1 FROM contracts c
             WHERE ((c.client_id = :a AND c.freelancer_id = :b)
                 OR (c.client_id = :b AND c.freelancer_id = :a))
               AND c.status IN ${OPEN_CONTRACT_STATUSES})
          OR EXISTS (
            SELECT 1 FROM barter_agreements ba
             WHERE ((ba.proposer_id = :a AND ba.receiver_id = :b)
                 OR (ba.proposer_id = :b AND ba.receiver_id = :a))
               AND ba.status IN ${OPEN_BARTER_STATUSES})
        ) AS open_relation`,
      { a: uidA, b: uidB },
    );
    return Number(rows[0]?.open_relation ?? 0) === 1;
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

  /**
   * As `limit` mensagens MAIS RECENTES da conversa, em ordem cronológica. A conversa é uma só por
   * par e atravessa as contratações: pegar as mais antigas congelava o histórico na 200ª mensagem.
   */
  async listMessages(conversationId: number, limit: number): Promise<MessageRow[]> {
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages
        WHERE conversation_id = :conversationId
        ORDER BY id DESC
        LIMIT ${limit}`,
      { conversationId },
    );
    return rows.reverse();
  },

  /**
   * Insere texto (attachment null) ou imagem/arquivo (content = legenda opcional), com os sinais de
   * negociação por fora achados no texto (ADR 45).
   */
  async insertMessage(data: {
    conversationId: number;
    senderId: number;
    content: string | null;
    signals: OffPlatformSignal[];
    attachment?: (NewAttachment & { kind: 'image' | 'file' }) | null;
  }): Promise<MessageRow> {
    const a = data.attachment ?? null;
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO messages (conversation_id, sender_id, type, content, file_url, file_name, file_mime,
                             file_size_bytes, off_platform)
       VALUES (:conversationId, :senderId, :type, :content, :fileKey, :fileName, :fileMime, :fileSize,
               :offPlatform)`,
      {
        conversationId: data.conversationId,
        senderId: data.senderId,
        type: a ? a.kind : 'text',
        content: data.content,
        fileKey: a?.key ?? null,
        fileName: a?.name ?? null,
        fileMime: a?.mime ?? null,
        fileSize: a?.size ?? null,
        offPlatform: serializeSignals(data.signals),
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

  /**
   * Mensagens de anexo, sem legenda, gravadas dentro da transação de quem chama: os arquivos de uma
   * entrega (RF-035) entram no chat do par junto com a entrega, ou nada entra. Devolve os ids na
   * ordem dos arquivos.
   */
  async insertAttachments(
    conn: PoolConnection,
    data: {
      conversationId: number;
      senderId: number;
      files: ReadonlyArray<NewAttachment & { kind: 'image' | 'file' }>;
    },
  ): Promise<number[]> {
    const ids: number[] = [];
    for (const f of data.files) {
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO messages (conversation_id, sender_id, type, content, file_url, file_name, file_mime,
                               file_size_bytes)
         VALUES (:conversationId, :senderId, :type, NULL, :fileKey, :fileName, :fileMime, :fileSize)`,
        {
          conversationId: data.conversationId,
          senderId: data.senderId,
          type: f.kind,
          fileKey: f.key,
          fileName: f.name,
          fileMime: f.mime,
          fileSize: f.size,
        },
      );
      ids.push(res.insertId);
    }
    if (ids.length > 0) {
      await conn.query<ResultSetHeader>(
        `UPDATE conversations SET last_message_at = NOW() WHERE id = :conversationId`,
        { conversationId: data.conversationId },
      );
    }
    return ids;
  },

  /** Mensagens de anexo da conversa pelas chaves dos arquivos, na ordem em que foram gravadas. */
  async findByFileKeys(conversationId: number, keys: string[]): Promise<MessageRow[]> {
    if (keys.length === 0) return [];
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE conversation_id = :conversationId AND file_url IN (:keys)
        ORDER BY id`,
      { conversationId, keys },
    );
    return rows;
  },

  /** Tira a mensagem do ar pela moderação, ou devolve numa contestação aceita (ADR 44). */
  async setRemoved(conn: PoolConnection, id: number, removed: boolean): Promise<boolean> {
    const [res] = await conn.query<ResultSetHeader>(
      removed
        ? `UPDATE messages SET removed_at = NOW() WHERE id = :id AND removed_at IS NULL`
        : `UPDATE messages SET removed_at = NULL WHERE id = :id AND removed_at IS NOT NULL`,
      { id },
    );
    return res.affectedRows > 0;
  },

  /**
   * Marca como lidas (RF-059) as mensagens que `readerId` RECEBEU na conversa, até `upTo` (a última
   * que a tela mostrou; null = todas) — nunca as que ele mesmo mandou. Idempotente: a já lida fica
   * com o horário da primeira leitura. Primeiro acha a maior não lida, numa consulta sem trava que,
   * no caso comum (nada a marcar), encerra sem escrever; depois grava só até ela, e a mensagem que
   * chegar entre as duas instruções continua não lida.
   */
  async markRead(
    conversationId: number,
    readerId: number,
    upTo: number | null,
  ): Promise<MarkReadResult> {
    const bound = upTo === null ? '' : ' AND id <= :upTo';
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT MAX(id) AS last FROM messages
        WHERE conversation_id = :conversationId AND read_at IS NULL
          AND sender_id <> :readerId${bound}`,
      { conversationId, readerId, upTo },
    );
    const last = rows[0]?.last == null ? null : Number(rows[0].last);
    if (last === null) return { marked: 0, upToId: null, readAt: null };
    // DATETIME sem fração: o horário vai em segundos inteiros, igual ao que o banco devolve depois.
    const readAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE messages SET is_read = 1, read_at = :readAt
        WHERE conversation_id = :conversationId AND read_at IS NULL
          AND sender_id <> :readerId AND id <= :last`,
      { conversationId, readerId, readAt, last },
    );
    // Outra aba marcou as mesmas no meio do caminho: nada mudou por esta chamada.
    if (res.affectedRows === 0) return { marked: 0, upToId: null, readAt: null };
    return { marked: res.affectedRows, upToId: last, readAt };
  },

  /** Uma mensagem pelo id (para o aviso em tempo real quando ela muda). */
  async findById(id: number): Promise<MessageRow | undefined> {
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /**
   * Todas as contratações entre as duas pessoas da conversa. A conversa é uma só por par e guarda
   * só o PRIMEIRO contrato (conversations.contract_id), mas cada parte acompanha o chat na sala do
   * contrato que está aberto na tela.
   */
  async pairContractIds(conversationId: number): Promise<number[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.id
         FROM conversations cv
         JOIN contracts c
           ON (c.client_id = cv.participant_a AND c.freelancer_id = cv.participant_b)
           OR (c.client_id = cv.participant_b AND c.freelancer_id = cv.participant_a)
        WHERE cv.id = :conversationId
        ORDER BY c.id`,
      { conversationId },
    );
    return rows.map((r) => Number(r.id));
  },

  /** Anexo de uma mensagem com as partes da conversa (para checar quem pode baixar). */
  async findAttachment(messageId: number): Promise<AttachmentRow | undefined> {
    const [rows] = await pool.query<AttachmentRow[]>(
      `SELECT m.id, m.type, m.file_url, m.file_name, m.file_mime, m.file_size_bytes,
              m.file_purged_at, m.file_purged_reason, m.removed_at, cv.participant_a,
              cv.participant_b
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.id = :messageId AND m.file_url IS NOT NULL
        LIMIT 1`,
      { messageId },
    );
    return rows[0];
  },

  // ---------- expurgo (ADR 31) ----------

  /** Anexos com mais de `cutoff` em conversas SEM contratação aberta entre as duas pessoas. */
  async listPurgeable(cutoff: Date, limit: number): Promise<{ id: number; file_url: string }[]> {
    // limit é uma constante do job (inteiro) — seguro para interpolar.
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT m.id, m.file_url
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.has_file = 1 AND m.file_purged_at IS NULL AND m.created_at < :cutoff
          AND NOT EXISTS (
            SELECT 1 FROM contracts c
             WHERE ((c.client_id = cv.participant_a AND c.freelancer_id = cv.participant_b)
                 OR (c.client_id = cv.participant_b AND c.freelancer_id = cv.participant_a))
               AND c.status IN ${OPEN_CONTRACT_STATUSES})
        ORDER BY m.id
        LIMIT ${Math.trunc(limit)}`,
      { cutoff },
    );
    return rows as { id: number; file_url: string }[];
  },

  /** Anexos ainda no disco enviados por um usuário (expurgo LGPD). */
  async listUserAttachments(userId: number): Promise<{ id: number; file_url: string }[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, file_url FROM messages
        WHERE sender_id = :userId AND has_file = 1 AND file_purged_at IS NULL`,
      { userId },
    );
    return rows as { id: number; file_url: string }[];
  },

  async markPurged(id: number, reason: PurgeReason): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE messages SET file_purged_at = NOW(), file_purged_reason = :reason
        WHERE id = :id AND file_purged_at IS NULL`,
      { id, reason },
    );
  },

  /** Chaves dos anexos que ainda deveriam estar no disco. */
  async listAttachmentKeys(): Promise<string[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT file_url FROM messages WHERE has_file = 1 AND file_purged_at IS NULL`,
    );
    return rows.map((r) => String(r.file_url));
  },

  async attachmentStats(): Promise<{
    active: number;
    activeBytes: number;
    purged: number;
    purged30d: number;
  }> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(file_purged_at IS NULL), 0) AS active,
              COALESCE(SUM(CASE WHEN file_purged_at IS NULL THEN file_size_bytes END), 0) AS active_bytes,
              COALESCE(SUM(file_purged_at IS NOT NULL), 0) AS purged,
              COALESCE(SUM(file_purged_at >= NOW() - INTERVAL 30 DAY), 0) AS purged_30d
         FROM messages
        WHERE has_file = 1`,
    );
    const r = rows[0]!;
    return {
      active: Number(r.active),
      activeBytes: Number(r.active_bytes),
      purged: Number(r.purged),
      purged30d: Number(r.purged_30d),
    };
  },
};
