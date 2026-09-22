import type { Request, Response } from 'express';
import { HttpError } from '../../utils/http-error';
import {
  emailPreferenceSchema,
  listNotificationsSchema,
  notificationIdSchema,
  pushEndpointSchema,
  pushStatusQuerySchema,
  pushSubscriptionSchema,
} from './notifications.schema';
import { notificationsService } from './notifications.service';
import { buildPayload, pushService } from './push.service';

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

/** GET /notifications/push — chave pública para assinar e quantos aparelhos já recebem (ADR 52). */
export async function getPushStatus(req: Request, res: Response): Promise<void> {
  const { endpoint } = pushStatusQuerySchema.parse(req.query);
  res.json({
    publicKey: pushService.publicKey(),
    devices: await pushService.devices(req.user!.uid),
    // Com o endpoint deste aparelho, diz se a assinatura dele é desta conta (ADR 52).
    subscribed: endpoint ? await pushService.subscribed(req.user!.uid, endpoint) : false,
  });
}

/** POST /notifications/push — liga os avisos neste aparelho (reassinar atualiza as chaves). */
export async function subscribePush(req: Request, res: Response): Promise<void> {
  const sub = pushSubscriptionSchema.parse(req.body);
  await pushService.subscribe(req.user!.uid, {
    ...sub,
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
  });
  res.status(201).json({ devices: await pushService.devices(req.user!.uid) });
}

/** DELETE /notifications/push — desliga este aparelho. */
export async function unsubscribePush(req: Request, res: Response): Promise<void> {
  const { endpoint } = pushEndpointSchema.parse(req.body);
  const removed = await pushService.unsubscribe(req.user!.uid, endpoint);
  if (!removed) throw new HttpError(404, 'Aparelho não encontrado', 'push_not_found');
  res.status(204).send();
}

/** POST /notifications/push/test — manda um aviso de teste para os aparelhos da conta. */
export async function testPush(req: Request, res: Response): Promise<void> {
  const result = await pushService.send(
    req.user!.uid,
    buildPayload({
      type: 'push_test',
      title: 'Tudo certo!',
      body: 'É assim que os avisos do Escambo vão chegar neste aparelho.',
    }),
  );
  res.json(result);
}

export async function readAllNotifications(req: Request, res: Response): Promise<void> {
  const read = await notificationsService.markAllRead(req.user!.uid);
  res.json({ read });
}
