import type {
  AdminReplySupportTicketRequest,
  CreateSupportTicketRequest,
  Paginated,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketQuery,
  UpdateSupportTicketRequest,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { notificationsService, type NotifyInput } from '../notifications/notifications.service';
import { supportRepository, type SupportTicketRow } from './support.repository';

const iso = (date: Date | null): string | null => (date ? new Date(date).toISOString() : null);
export function toSupportTicket(row: SupportTicketRow): SupportTicket {
  return {
    id: row.id,
    ulid: row.ulid,
    userId: row.user_id,
    ownerDeleted: Boolean(row.owner_deleted),
    contractId: row.contract_id,
    category: row.category,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    firstResponseAt: iso(row.first_response_at),
    slaDueAt: new Date(row.sla_due_at).toISOString(),
    slaAlertedAt: iso(row.sla_alerted_at),
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
async function notice(uid: number, input: NotifyInput, admin: boolean): Promise<void> {
  try {
    const saved = await supportRepository.saveNotice(uid, input, admin);
    if (saved) notificationsService.dispatch(saved);
  } catch {
    // Nada de assunto, texto, SQL ou erro que possa conter parâmetros privados.
    logger.warn({ ticketId: input.data?.supportTicketId }, 'suporte: aviso opcional não entregue');
  }
}
async function notifyAdmins(id: number, type: string, senderId: number): Promise<void> {
  try {
    const admins = await supportRepository.activeAdmins();
    await Promise.all(
      admins
        .filter((uid) => uid !== senderId)
        .map((uid) =>
          notice(
            uid,
            {
              type,
              title:
                type === 'support_opened' ? 'Novo chamado de suporte' : 'Nova resposta em chamado',
              body: 'Há um chamado aguardando atendimento.',
              data: { supportTicketId: id, supportAdmin: true },
            },
            true,
          ),
        ),
    );
  } catch {
    logger.warn({ ticketId: id }, 'suporte: aviso à equipe não entregue');
  }
}

export const supportService = {
  async list(uid: number | null, query: SupportTicketQuery): Promise<Paginated<SupportTicket>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const rows = await supportRepository.list(uid, { ...query, page, limit });
    return { items: rows.map(toSupportTicket), page, limit };
  },
  async detail(id: number, uid: number | null, beforeId?: number): Promise<SupportTicketDetail> {
    const row = await supportRepository.find(id, uid);
    if (!row) throw new HttpError(404, 'Chamado não encontrado', 'ticket_not_found');
    const rows = await supportRepository.messages(id, uid === null, beforeId);
    const window = rows.slice(0, 50);
    return {
      ...toSupportTicket(row),
      messages: window.reverse().map((m) => ({
        id: m.id,
        ticketId: m.ticket_id,
        senderId: m.sender_id,
        from: m.sender_id === row.user_id ? 'user' : 'support',
        message: m.message,
        internal: Boolean(m.is_internal),
        createdAt: new Date(m.created_at).toISOString(),
      })),
      nextBeforeId: rows.length > 50 ? window[0]!.id : null,
    };
  },
  async create(uid: number, input: CreateSupportTicketRequest): Promise<SupportTicketDetail> {
    const id = await supportRepository.create(uid, input);
    await notifyAdmins(id, 'support_opened', uid);
    return this.detail(id, uid);
  },
  async reply(
    id: number,
    uid: number,
    admin: boolean,
    input: AdminReplySupportTicketRequest,
  ): Promise<SupportTicketDetail> {
    if (!(await supportRepository.reply(id, uid, admin, input))) {
      throw new HttpError(409, 'Este chamado está encerrado', 'ticket_closed');
    }
    const detail = await this.detail(id, admin ? null : uid);
    if (admin && !input.internal && detail.userId !== uid) {
      await notice(
        detail.userId,
        {
          type: input.resolve ? 'support_resolved' : 'support_reply',
          title: input.resolve ? 'Seu chamado foi resolvido' : 'Seu chamado recebeu uma resposta',
          body: 'Consulte o atendimento para ver os detalhes.',
          data: { supportTicketId: id },
        },
        false,
      );
    } else if (!admin) await notifyAdmins(id, 'support_reply', uid);
    return detail;
  },
  async close(id: number, uid: number): Promise<SupportTicketDetail> {
    await supportRepository.close(id, uid);
    return this.detail(id, uid);
  },
  async update(
    id: number,
    adminId: number,
    input: UpdateSupportTicketRequest,
  ): Promise<SupportTicketDetail> {
    await supportRepository.update(id, adminId, input);
    return this.detail(id, null);
  },
};
