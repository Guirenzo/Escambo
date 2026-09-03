import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';

export interface ConversationRow extends RowDataPacket {
  id: number;
  contract_id: number | null;
  participant_a: number;
  participant_b: number;
}

export interface MessageRow extends RowDataPacket {
  id: number;
  conversation_id: number;
  sender_id: number;
  content: string | null;
  created_at: Date;
}

/** Normaliza o par (a<b) para casar com a unique key uq_conversation. */
function orderPair(x: number, y: number): [number, number] {
  return x <= y ? [x, y] : [y, x];
}

export const messagingRepository = {
  /**
   * Retorna a conversa entre as duas partes (única por par), criando se não
   * existir. Associa/atualiza o contrato quando informado.
   */
  async getOrCreate(uidA: number, uidB: number, contractId: number): Promise<number> {
    const [a, b] = orderPair(uidA, uidB);
    const [rows] = await pool.query<ConversationRow[]>(
      `SELECT id, contract_id FROM conversations WHERE participant_a = :a AND participant_b = :b LIMIT 1`,
      { a, b },
    );
    const existing = rows[0];
    if (existing) {
      if (existing.contract_id == null) {
        await pool.query<ResultSetHeader>(
          `UPDATE conversations SET contract_id = :contractId WHERE id = :id`,
          { contractId, id: existing.id },
        );
      }
      return existing.id;
    }
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO conversations (contract_id, participant_a, participant_b) VALUES (:contractId, :a, :b)`,
      { contractId, a, b },
    );
    return res.insertId;
  },

  async listMessages(conversationId: number, limit: number): Promise<MessageRow[]> {
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT id, conversation_id, sender_id, content, created_at
         FROM messages
        WHERE conversation_id = :conversationId
        ORDER BY id ASC
        LIMIT ${limit}`,
      { conversationId },
    );
    return rows;
  },

  async insertMessage(data: {
    conversationId: number;
    senderId: number;
    content: string;
  }): Promise<MessageRow> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO messages (conversation_id, sender_id, type, content)
       VALUES (:conversationId, :senderId, 'text', :content)`,
      data,
    );
    await pool.query<ResultSetHeader>(
      `UPDATE conversations SET last_message_at = NOW() WHERE id = :conversationId`,
      { conversationId: data.conversationId },
    );
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT id, conversation_id, sender_id, content, created_at FROM messages WHERE id = :id`,
      { id: res.insertId },
    );
    return rows[0]!;
  },
};
