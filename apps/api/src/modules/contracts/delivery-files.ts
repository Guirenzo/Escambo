import type { DeliveryAttachment } from '@escambo/types';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/db';
import { attachmentUrl } from '../messaging/attachments.storage';
import { messagingRepository, type PurgeReason } from '../messaging/messaging.repository';
import type { StoredAttachment } from '../messaging/messaging.service';

/**
 * Arquivos de uma entrega (RF-035). Cada arquivo é um anexo do chat do par (ADR 29): a linha em
 * messages tem a chave no disco, o nome, o tipo, o tamanho, o expurgo (ADR 31) e a remoção pela
 * moderação (ADR 44), e o download é a rota do chat, que confere se quem pede é parte da conversa.
 * delivery_files só diz de que entrega ele é: a entrega única (delivery_id) ou a de um marco
 * (milestone_id). Assim a entrega herda tipos aceitos, limites, retenção, expurgo LGPD, órfãos e
 * moderação do chat, sem um segundo armazenamento para manter.
 */

/** Arquivos por entrega; cada um segue o limite do anexo do chat (UPLOAD_MAX_MB). */
export const DELIVERY_MAX_FILES = 10;
/** Soma dos arquivos de uma entrega: cabe no corpo de 25 MB que o nginx aceita em /api/. */
export const DELIVERY_MAX_TOTAL_MB = 24;
export const DELIVERY_MAX_TOTAL_BYTES = DELIVERY_MAX_TOTAL_MB * 1024 * 1024;

/** Os arquivos já gravados no disco e a conversa do par em que eles entram. */
export interface DeliveryFilesInput {
  conversationId: number;
  senderId: number;
  files: StoredAttachment[];
}

/** A entrega a que os arquivos pertencem: a única (uma por reentrega) ou a de um marco. */
export type DeliveryTarget =
  { contractId: number; deliveryId: number } | { contractId: number; milestoneId: number };

export interface DeliveryFileRow extends RowDataPacket {
  message_id: number;
  delivery_id: number | null;
  milestone_id: number | null;
  file_name: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  file_purged_at: Date | null;
  file_purged_reason: PurgeReason | null;
  removed_at: Date | null;
  created_at: Date;
}

export const deliveryFilesRepository = {
  /**
   * Dentro da transação da entrega: grava uma mensagem de anexo por arquivo na conversa do par e
   * liga cada uma à entrega. Devolve os ids das mensagens.
   */
  async attach(
    conn: PoolConnection,
    target: DeliveryTarget,
    input: DeliveryFilesInput,
  ): Promise<number[]> {
    const ids = await messagingRepository.insertAttachments(conn, {
      conversationId: input.conversationId,
      senderId: input.senderId,
      files: input.files,
    });
    if (ids.length === 0) return ids;
    const rows = ids.map((_, i) => `(:m${i}, :contractId, :deliveryId, :milestoneId)`).join(', ');
    await conn.query<ResultSetHeader>(
      `INSERT INTO delivery_files (message_id, contract_id, delivery_id, milestone_id)
       VALUES ${rows}`,
      {
        contractId: target.contractId,
        deliveryId: 'deliveryId' in target ? target.deliveryId : null,
        milestoneId: 'milestoneId' in target ? target.milestoneId : null,
        ...Object.fromEntries(ids.map((id, i) => [`m${i}`, id])),
      },
    );
    return ids;
  },

  /** Todos os arquivos das entregas da contratação, na ordem em que foram enviados. */
  async listForContract(contractId: number): Promise<DeliveryFileRow[]> {
    const [rows] = await pool.query<DeliveryFileRow[]>(
      `SELECT df.message_id, df.delivery_id, df.milestone_id, m.file_name, m.file_mime,
              m.file_size_bytes, m.file_purged_at, m.file_purged_reason, m.removed_at, m.created_at
         FROM delivery_files df
         JOIN messages m ON m.id = df.message_id
        WHERE df.contract_id = :contractId
        ORDER BY df.message_id ASC`,
      { contractId },
    );
    return rows;
  },
};

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/**
 * O arquivo como a Sala mostra. Removido pela moderação, como no chat (ADR 44), as partes veem só
 * o aviso: o nome e o tamanho saem, e o download responde 410.
 */
export function toDeliveryAttachment(r: DeliveryFileRow): DeliveryAttachment {
  const removedAt = iso(r.removed_at);
  return {
    messageId: Number(r.message_id),
    name: removedAt ? '' : (r.file_name ?? 'arquivo'),
    mime: r.file_mime ?? 'application/octet-stream',
    size: removedAt ? 0 : Number(r.file_size_bytes ?? 0),
    url: attachmentUrl(Number(r.message_id)),
    purgedAt: iso(r.file_purged_at),
    purgedReason: r.file_purged_at ? (r.file_purged_reason ?? 'missing') : null,
    removedAt,
    sentAt: new Date(r.created_at).toISOString(),
  };
}

/** Os arquivos de uma entrega única ou de um marco, no formato da API. */
export function attachmentsOf(
  rows: readonly DeliveryFileRow[],
  target: { deliveryId: number } | { milestoneId: number },
): DeliveryAttachment[] {
  return rows
    .filter((r) =>
      'deliveryId' in target
        ? Number(r.delivery_id) === target.deliveryId && r.delivery_id != null
        : Number(r.milestone_id) === target.milestoneId && r.milestone_id != null,
    )
    .map(toDeliveryAttachment);
}
