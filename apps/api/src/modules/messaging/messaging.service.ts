import type { ChatAttachment, ChatHistory, ChatMessage } from '@escambo/types';
import { realtime } from '../../config/realtime';
import { HttpError } from '../../utils/http-error';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';
import { profilesRepository } from '../profiles/profiles.repository';
import { logger } from '../../config/logger';
import {
  attachmentPath,
  attachmentSize,
  contentDisposition,
  detectType,
  removeAttachment,
  safeFileName,
  saveAttachment,
  type AttachmentKind,
} from './attachments.storage';
import { messagingRepository, type MessageRow, type PurgeReason } from './messaging.repository';

const HISTORY_LIMIT = 200;

/** Arquivo recebido pelo multipart (subconjunto do Express.Multer.File que interessa aqui). */
export interface UploadedFile {
  buffer: Buffer;
  originalname?: string;
}

/** O que o controller precisa para servir um anexo. */
export interface AttachmentFile {
  path: string;
  mime: string;
  size: number;
  /** Cabeçalho Content-Disposition pronto (inline para imagem, attachment para o resto). */
  disposition: string;
}

export const attachmentUrl = (messageId: number): string =>
  `/api/messaging/attachments/${messageId}`;

function toAttachment(row: MessageRow): ChatAttachment | null {
  if (!row.file_url) return null;
  return {
    name: row.file_name ?? 'arquivo',
    mime: row.file_mime ?? 'application/octet-stream',
    size: Number(row.file_size_bytes ?? 0),
    url: attachmentUrl(row.id),
    purgedAt: row.file_purged_at ? new Date(row.file_purged_at).toISOString() : null,
    purgedReason: row.file_purged_reason ?? null,
  };
}

/** Mensagem do 410 quando o arquivo já saiu do disco (ADR 31). */
const PURGED_MESSAGE: Record<PurgeReason, string> = {
  retention: 'Este anexo foi removido pela política de retenção',
  lgpd: 'Este anexo foi removido a pedido do titular',
  missing: 'O arquivo deste anexo não está mais disponível',
};

function toMessage(row: MessageRow): ChatMessage {
  // Removida pela moderação (ADR 44): as duas partes veem o aviso, sem o texto nem o anexo.
  const removedAt = row.removed_at ? new Date(row.removed_at).toISOString() : null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    type: row.type === 'image' || row.type === 'file' ? row.type : 'text',
    content: removedAt ? '' : (row.content ?? ''),
    attachment: removedAt ? null : toAttachment(row),
    createdAt: new Date(row.created_at).toISOString(),
    removedAt,
  };
}

/** Texto da notificação: a legenda, ou o que foi enviado. */
export function notificationBody(message: ChatMessage): string {
  const text = message.content.trim();
  if (text) return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  if (message.type === 'image') return 'Enviou uma imagem';
  return `Enviou o arquivo ${message.attachment?.name ?? ''}`.trim();
}

interface ConversationContext {
  contract: ContractRow;
  conversationId: number;
  otherPartyId: number;
}

/** Carrega o contrato, garante que o usuário é parte e resolve a conversa. */
async function contextFor(contractId: number, uid: number): Promise<ConversationContext> {
  const contract = await contractsRepository.findById(contractId);
  if (!contract) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
  if (contract.client_id !== uid && contract.freelancer_id !== uid) {
    throw new HttpError(403, 'Você não participa desta contratação', 'forbidden');
  }
  const otherPartyId = contract.client_id === uid ? contract.freelancer_id : contract.client_id;
  const conversationId = await messagingRepository.getOrCreate(
    contract.client_id,
    contract.freelancer_id,
    contractId,
  );
  return { contract, conversationId, otherPartyId };
}

/** Horas entre a última mensagem do cliente e a resposta do freelancer (se for uma resposta). */
export function responseHours(
  previous: { sender_id: number; created_at: Date } | undefined,
  clientId: number,
  now: Date = new Date(),
): number | null {
  if (!previous || previous.sender_id !== clientId) return null;
  const ms = now.getTime() - new Date(previous.created_at).getTime();
  return Math.max(0, Math.round((ms / 3_600_000) * 100) / 100);
}

async function recordResponseTime(ctx: ConversationContext, messageId: number): Promise<void> {
  const previous = await messagingRepository.previousMessage(ctx.conversationId, messageId);
  const hours = responseHours(previous, ctx.contract.client_id);
  if (hours == null) return;
  await profilesRepository.blendResponseTime(ctx.contract.freelancer_id, hours);
}

/** Depois de persistir: responsividade, tempo real e notificação — igual para texto e anexo. */
function deliver(ctx: ConversationContext, uid: number, row: MessageRow): ChatMessage {
  const message = toMessage(row);
  const contractId = ctx.contract.id;

  // Responsividade do freelancer: quando ele responde a uma mensagem do cliente, o tempo
  // decorrido vira amostra do tempo médio de resposta (dimensão do Escambo Score).
  if (uid === ctx.contract.freelancer_id) {
    void recordResponseTime(ctx, row.id).catch((err) =>
      logger.warn({ err }, 'responsividade: não foi possível registrar'),
    );
  }

  // Broadcast para a sala do contrato (no-op se não houver Socket.IO anexado).
  realtime.emitToContract(contractId, 'message:new', { ...message, contractId });

  // Notificação in-app best-effort para o destinatário.
  void notificationsService.notify(ctx.otherPartyId, {
    type: 'chat_message',
    title: 'Nova mensagem',
    body: notificationBody(message),
    data: { contractId },
  });

  return message;
}

export const messagingService = {
  /** Avisa a sala do contrato que a mensagem mudou: removida ou devolvida pela moderação (ADR 44). */
  async announceChange(messageId: number): Promise<void> {
    const row = await messagingRepository.findWithContract(messageId);
    if (!row?.contract_id) return;
    realtime.emitToContract(row.contract_id, 'message:updated', {
      ...toMessage(row),
      contractId: row.contract_id,
    });
  },

  /** Histórico do chat do contrato (somente para as partes). */
  async history(contractId: number, uid: number): Promise<ChatHistory> {
    const ctx = await contextFor(contractId, uid);
    const rows = await messagingRepository.listMessages(ctx.conversationId, HISTORY_LIMIT);
    return {
      conversationId: ctx.conversationId,
      contractId,
      otherPartyId: ctx.otherPartyId,
      messages: rows.map(toMessage),
    };
  },

  /** Persiste uma mensagem de texto, transmite em tempo real e notifica a outra parte. */
  async send(contractId: number, uid: number, content: string): Promise<ChatMessage> {
    const ctx = await contextFor(contractId, uid);
    const row = await messagingRepository.insertMessage({
      conversationId: ctx.conversationId,
      senderId: uid,
      content,
    });
    return deliver(ctx, uid, row);
  },

  /**
   * Persiste uma imagem ou arquivo (ADR 29): o tipo vem dos primeiros bytes, nunca do nome ou
   * do Content-Type declarado; o arquivo vai para o disco antes da linha no banco e é removido
   * se a linha falhar — nunca fica linha apontando para arquivo que não existe.
   */
  async sendAttachment(
    contractId: number,
    uid: number,
    file: UploadedFile,
    caption: string | null,
  ): Promise<ChatMessage> {
    if (file.buffer.length === 0) throw new HttpError(422, 'O arquivo está vazio', 'empty_file');
    const type = detectType(file.buffer);
    if (!type) {
      throw new HttpError(
        422,
        'Tipo de arquivo não aceito: envie JPG, PNG, GIF, WebP, PDF ou ZIP',
        'unsupported_file_type',
      );
    }
    const ctx = await contextFor(contractId, uid);
    const key = await saveAttachment(file.buffer, type);
    let row: MessageRow;
    try {
      row = await messagingRepository.insertMessage({
        conversationId: ctx.conversationId,
        senderId: uid,
        content: caption?.trim() ? caption.trim() : null,
        attachment: {
          kind: type.kind,
          key,
          name: safeFileName(file.originalname, type),
          mime: type.mime,
          size: file.buffer.length,
        },
      });
    } catch (err) {
      await removeAttachment(key);
      throw err;
    }
    return deliver(ctx, uid, row);
  },

  /** Localiza o anexo para download: só as partes da conversa; 404 se sumiu do disco. */
  async attachment(messageId: number, uid: number): Promise<AttachmentFile> {
    const row = await messagingRepository.findAttachment(messageId);
    if (!row) throw new HttpError(404, 'Anexo não encontrado', 'attachment_not_found');
    if (row.participant_a !== uid && row.participant_b !== uid) {
      throw new HttpError(403, 'Você não participa desta conversa', 'forbidden');
    }
    if (row.removed_at) {
      throw new HttpError(410, 'Esta mensagem foi removida pela moderação', 'message_removed');
    }
    if (row.file_purged_at) {
      throw new HttpError(
        410,
        PURGED_MESSAGE[row.file_purged_reason ?? 'missing'],
        'attachment_purged',
      );
    }
    const path = attachmentPath(row.file_url);
    const size = path ? await attachmentSize(row.file_url) : null;
    if (!path || size == null) {
      logger.warn({ messageId, key: row.file_url }, 'anexo sem arquivo no disco');
      // Marca de vez: a bolha passa a dizer "indisponível" e o job não tenta apagar de novo.
      void messagingRepository.markPurged(messageId, 'missing').catch(() => undefined);
      throw new HttpError(
        404,
        'O arquivo deste anexo não está mais disponível',
        'attachment_missing',
      );
    }
    const kind: AttachmentKind = row.type === 'image' ? 'image' : 'file';
    return {
      path,
      mime: row.file_mime ?? 'application/octet-stream',
      size,
      disposition: contentDisposition(kind, row.file_name ?? `arquivo`),
    };
  },
};
