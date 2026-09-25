import type {
  EmailPreference,
  Notification,
  NotificationList,
  QuietPassCategory,
  UpdateEmailPreferenceRequest,
} from '@escambo/types';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { realtime } from '../../config/realtime';
import { HttpError } from '../../utils/http-error';
import { timezoneOf } from '../../utils/timezone';
import { pushService } from './push.service';
import { quietPassOf, quietWindowOf } from './quiet-hours';
import { authRepository } from '../auth/auth.repository';
import { EMAILED_NOTIFICATION_TYPES, mailService, notificationLink } from '../mail/mail.service';
import { notificationsRepository, type NotificationRow } from './notifications.repository';

/** O título cabe em notifications.title (VARCHAR(150)). */
export const NOTIFICATION_TITLE_MAX = 150;

/**
 * Corta o título na coluna, com reticência: um título que carrega o nome da contratação ("Prazo
 * estourado: …", ADR 56; "Marco atrasado: …") não pode derrubar a notificação inteira.
 */
export const clipTitle = (title: string): string =>
  title.length <= NOTIFICATION_TITLE_MAX
    ? title
    : `${title.slice(0, NOTIFICATION_TITLE_MAX - 1).trimEnd()}…`;

/** Notificações relevantes também vão por e-mail (melhor esforço, fora do caminho da resposta). */
async function emailNotification(
  userId: number,
  params: {
    type: string;
    title: string;
    body?: string | null;
    data?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!EMAILED_NOTIFICATION_TYPES.has(params.type) || !mailService.enabled()) return;
  const user = await authRepository.findById(userId);
  if (!user || user.deleted_at) return;
  // Resumo diário (job) ou só e-mails essenciais: nada de e-mail por evento (ADR 27).
  if (user.email_frequency && user.email_frequency !== 'instant') return;
  await mailService.send({
    userId,
    to: user.email,
    template: 'notification',
    vars: { title: params.title, body: params.body ?? null, link: notificationLink(params.data) },
  });
}

export function toNotification(r: NotificationRow): Notification {
  const data =
    r.data == null
      ? null
      : typeof r.data === 'string'
        ? (JSON.parse(r.data) as Record<string, unknown>)
        : r.data;
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
  /**
   * Cria uma notificação in-app. Best-effort: usada em hooks de evento, nunca lança. `passCategory`
   * é só para o push (ADR 56): não é gravada, não vai no socket nem no e-mail.
   */
  async notify(
    userId: number,
    input: {
      type: string;
      title: string;
      body?: string | null;
      data?: Record<string, unknown> | null;
    },
    opts: { passCategory?: QuietPassCategory } = {},
  ): Promise<void> {
    // O mesmo título, cortado, no banco, no socket, no e-mail e no push.
    const params = { ...input, title: clipTitle(input.title) };
    try {
      const id = await notificationsRepository.create({
        userId,
        type: params.type,
        title: params.title,
        body: params.body ?? null,
        data: params.data != null ? JSON.stringify(params.data) : null,
      });
      // Push em tempo real para as conexões do usuário (badge, toast, invalidação de cache).
      const pushed: Notification = {
        id,
        type: params.type,
        title: params.title,
        body: params.body ?? null,
        data: params.data ?? null,
        isRead: false,
        createdAt: new Date().toISOString(),
      };
      realtime.emitToUser(userId, 'notification:new', pushed);
      emailNotification(userId, params).catch((err) =>
        logger.warn({ err, type: params.type }, 'e-mail da notificação falhou'),
      );
      // Aviso no navegador dos aparelhos ligados (ADR 52): mesmo tratamento do e-mail.
      void pushService.notify(userId, {
        ...params,
        notificationId: id,
        ...(opts.passCategory ? { passCategory: opts.passCategory } : {}),
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

  // ---------- Preferência de e-mail (ADR 27) ----------

  async getEmailPreference(userId: number): Promise<EmailPreference> {
    const user = await authRepository.findById(userId);
    return {
      emailFrequency: user?.email_frequency ?? 'instant',
      digestHour: user?.digest_hour ?? env.DIGEST_HOUR,
      timezone: timezoneOf(user?.timezone),
      quietHours: quietWindowOf(user?.push_quiet_start, user?.push_quiet_end),
      quietPass: quietPassOf(user?.push_quiet_pass),
    };
  },

  /** Frequência e hora do resumo do dia (ADR 42): muda só o que vier e devolve como ficou. */
  async setEmailPreference(
    userId: number,
    change: UpdateEmailPreferenceRequest,
  ): Promise<EmailPreference> {
    await authRepository.setEmailPreference(userId, change);
    return this.getEmailPreference(userId);
  },

  /**
   * Resumo diário de um usuário: as notificações desde o último resumo (ou das últimas 24h)
   * num e-mail só. Devolve quantos itens foram; 0 = nada enviado (mas o dia fica marcado).
   */
  async sendDigest(
    user: { id: number; email: string; last_digest_at: Date | null },
    now: Date,
  ): Promise<number> {
    const since = user.last_digest_at ?? new Date(now.getTime() - 24 * 3_600_000);
    const rows = await notificationsRepository.listSince(user.id, since);
    if (rows.length > 0) {
      const items = rows.map(toNotification).map((n) => ({
        title: n.title,
        body: n.body,
        link: notificationLink(n.data),
      }));
      await mailService.send({
        userId: user.id,
        to: user.email,
        template: 'digest',
        vars: { items },
      });
    }
    await notificationsRepository.markDigest(user.id, now);
    return rows.length;
  },
};
