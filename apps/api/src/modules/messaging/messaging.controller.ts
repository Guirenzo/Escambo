import type { Request, Response } from 'express';
import { contractIdParamSchema, sendMessageSchema } from './messaging.schema';
import { messagingService } from './messaging.service';

/** GET /api/messaging/contracts/:id — histórico do chat do contrato. */
export async function getMessages(req: Request, res: Response): Promise<void> {
  const { id } = contractIdParamSchema.parse(req.params);
  res.json(await messagingService.history(id, req.user!.uid));
}

/** POST /api/messaging/contracts/:id — envia uma mensagem. */
export async function postMessage(req: Request, res: Response): Promise<void> {
  const { id } = contractIdParamSchema.parse(req.params);
  const { content } = sendMessageSchema.parse(req.body);
  const message = await messagingService.send(id, req.user!.uid, content);
  res.status(201).json(message);
}
