import type { ChatHistory, ChatMessage } from '@escambo/types';
import { realtime } from '../../config/realtime';
import { HttpError } from '../../utils/http-error';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';
import { profilesRepository } from '../profiles/profiles.repository';
import { logger } from '../../config/logger';
import { messagingRepository, type MessageRow } from './messaging.repository';

const HISTORY_LIMIT = 200;

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content ?? '',
    createdAt: new Date(row.created_at).toISOString(),
  };
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

export const messagingService = {
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

  /** Persiste uma mensagem, transmite em tempo real e notifica a outra parte. */
  async send(contractId: number, uid: number, content: string): Promise<ChatMessage> {
    const ctx = await contextFor(contractId, uid);
    const row = await messagingRepository.insertMessage({
      conversationId: ctx.conversationId,
      senderId: uid,
      content,
    });
    const message = toMessage(row);

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
      body: content.length > 120 ? `${content.slice(0, 117)}…` : content,
      data: { contractId },
    });

    return message;
  },
};
