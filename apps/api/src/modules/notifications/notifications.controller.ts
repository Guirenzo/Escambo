import type { Request, Response } from 'express';
import { listNotificationsSchema, notificationIdSchema } from './notifications.schema';
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

export async function readAllNotifications(req: Request, res: Response): Promise<void> {
  const read = await notificationsService.markAllRead(req.user!.uid);
  res.json({ read });
}
