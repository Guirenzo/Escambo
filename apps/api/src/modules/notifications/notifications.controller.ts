import type { Request, Response } from 'express';
import {
  emailPreferenceSchema,
  listNotificationsSchema,
  notificationIdSchema,
} from './notifications.schema';
import { notificationsService } from './notifications.service';

export async function getNotifications(req: Request, res: Response): Promise<void> {
  const { page, limit } = listNotificationsSchema.parse(req.query);
  res.json(await notificationsService.list(req.user!.uid, page, limit));
}

export async function readNotification(req: Request, res: Response): Promise<void> {
  const { id } = notificationIdSchema.parse(req.params);
  await notificationsService.markRead(id, req.user!.uid);
  res.status(204).send();
}

/** GET /notifications/preferences — como o usuário quer os e-mails. */
export async function getEmailPreference(req: Request, res: Response): Promise<void> {
  res.json(await notificationsService.getEmailPreference(req.user!.uid));
}

/**
 * PUT /notifications/preferences — a cada evento, resumo diário ou só o essencial, e a hora do
 * resumo do dia (ADR 42). Muda só o que vier e devolve como ficou.
 */
export async function updateEmailPreference(req: Request, res: Response): Promise<void> {
  const change = emailPreferenceSchema.parse(req.body);
  res.json(await notificationsService.setEmailPreference(req.user!.uid, change));
}

export async function readAllNotifications(req: Request, res: Response): Promise<void> {
  const read = await notificationsService.markAllRead(req.user!.uid);
  res.json({ read });
}
