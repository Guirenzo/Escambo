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
import { pushService } from './push.service';
import { auditService } from '../audit/audit.service';

/** IP e navegador da requisição: a prova de quem ligou ou desligou os avisos (LGPD art. 8 §2). */
const ctx = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

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
  const saved = await notificationsService.setEmailPreference(req.user!.uid, change);
  // O que sai no silêncio muda o que vai ao serviço de push (prioridade alta, ADR 56): fica a
  // trilha de quando e de onde a pessoa escolheu, como ao ligar um aparelho (art. 8 §2).
  if (change.quietPass !== undefined) {
    void auditService.log({
      userId: req.user!.uid,
      action: 'push_quiet_pass_changed',
      entityType: 'user',
      newValue: { quietPass: change.quietPass },
      ...ctx(req),
    });
  }
  res.json(saved);
}

/** GET /notifications/push — chave pública para assinar e quantos aparelhos já recebem (ADR 52). */
export async function getPushStatus(req: Request, res: Response): Promise<void> {
  const { endpoint } = pushStatusQuerySchema.parse(req.query);
  res.json({
    publicKey: pushService.publicKey(),
    devices: await pushService.devices(req.user!.uid),
    // Com o endpoint deste aparelho, diz se a assinatura dele é desta conta (ADR 52).
    subscribed: endpoint ? await pushService.subscribed(req.user!.uid, endpoint) : false,
    // Avisos retidos pelo silêncio, que o resumo ao fim da janela vai cobrir (ADR 54).
    held: await pushService.held(req.user!.uid),
    // Só quem entrega trabalho vê a escolha do que sai no silêncio (ADR 56).
    deliversWork: await pushService.deliversWork(req.user!.uid),
  });
}

/** POST /notifications/push — liga os avisos neste aparelho (reassinar atualiza as chaves). */
export async function subscribePush(req: Request, res: Response): Promise<void> {
  const sub = pushSubscriptionSchema.parse(req.body);
  await pushService.subscribe(req.user!.uid, sub);
  // Consentimento dado aparelho por aparelho (ADR 54): fica a trilha com o serviço de push (só o
  // host), nunca o endereço inteiro, e ela sobrevive ao apagamento da assinatura.
  void auditService.log({
    userId: req.user!.uid,
    action: 'push_subscribed',
    entityType: 'push_subscription',
    newValue: { host: new URL(sub.endpoint).hostname },
    ...ctx(req),
  });
  res.status(201).json({ devices: await pushService.devices(req.user!.uid) });
}

/** DELETE /notifications/push — desliga este aparelho. */
export async function unsubscribePush(req: Request, res: Response): Promise<void> {
  const { endpoint } = pushEndpointSchema.parse(req.body);
  const removed = await pushService.unsubscribe(req.user!.uid, endpoint);
  if (!removed) throw new HttpError(404, 'Aparelho não encontrado', 'push_not_found');
  void auditService.log({
    userId: req.user!.uid,
    action: 'push_unsubscribed',
    entityType: 'push_subscription',
    newValue: { host: new URL(endpoint).hostname },
    ...ctx(req),
  });
  res.status(204).send();
}

/** POST /notifications/push/test — manda um aviso de teste para os aparelhos da conta. */
export async function testPush(req: Request, res: Response): Promise<void> {
  res.json(await pushService.sendTest(req.user!.uid));
}

export async function readAllNotifications(req: Request, res: Response): Promise<void> {
  const read = await notificationsService.markAllRead(req.user!.uid);
  res.json({ read });
}
