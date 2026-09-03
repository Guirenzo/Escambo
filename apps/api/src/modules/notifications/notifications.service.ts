import type { Notification, NotificationList } from '@escambo/types';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { notificationsRepository, type NotificationRow } from './notifications.repository';

function toNotification(r: NotificationRow): Notification {
  const data =
    r.data == null ? null : typeof r.data === 'string' ? (JSON.parse(r.data) as Record<string, unknown>) : r.data;
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    data,
    isRead: Boolean(r.is_read),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const notificationsService = {
  /** Cria uma notificação in-app. Best-effort: usada em hooks de evento, nunca lança. */
  async notify(
    userId: number,
    params: { type: string; title: string; body?: string | null; data?: Record<string, unknown> | null },
  ): Promise<void> {
    try {
      await notificationsRepository.create({
        userId,
        type: params.type,
        title: params.title,
        body: params.body ?? null,
        data: params.data != null ? JSON.stringify(params.data) : null,
      });
    } catch (err) {
      logger.warn({ err }, 'notify falhou');
    }
  },

  async list(userId: number, page: number, limit: number): Promise<NotificationList> {
    const [rows, unreadCount] = await Promise.all([
      notificationsRepository.listForUser(userId, limit, (page - 1) * limit),
      notificationsRepository.countUnread(userId),
    ]);
    return { items: rows.map(toNotification), unreadCount, page, limit };
  },

  async markRead(id: number, userId: number): Promise<void> {
    const ok = await notificationsRepository.markRead(id, userId);
    if (!ok) throw new HttpError(404, 'Notificação não encontrada', 'notification_not_found');
  },

  async markAllRead(userId: number): Promise<number> {
    return notificationsRepository.markAllRead(userId);
  },
};
