import type { Request, Response } from 'express';
import { HttpError } from '../../utils/http-error';
import {
  attachmentBodySchema,
  contractIdParamSchema,
  messageIdParamSchema,
  sendMessageSchema,
} from './messaging.schema';
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

/** POST /api/messaging/contracts/:id/attachments — multipart: `file` + `content` (legenda). */
export async function postAttachment(req: Request, res: Response): Promise<void> {
  const { id } = contractIdParamSchema.parse(req.params);
  const { content } = attachmentBodySchema.parse(req.body ?? {});
  if (!req.file) throw new HttpError(422, 'Envie um arquivo no campo "file"', 'file_required');
  const message = await messagingService.sendAttachment(
    id,
    req.user!.uid,
    req.file,
    content ?? null,
  );
  res.status(201).json(message);
}

/** GET /api/messaging/attachments/:id — o arquivo da mensagem, só para as partes. */
export async function getAttachment(req: Request, res: Response): Promise<void> {
  const { id } = messageIdParamSchema.parse(req.params);
  const file = await messagingService.attachment(id, req.user!.uid);
  await new Promise<void>((resolve, reject) => {
    res.sendFile(
      file.path,
      {
        dotfiles: 'deny',
        cacheControl: false,
        headers: {
          'Content-Type': file.mime,
          'Content-Disposition': file.disposition,
          // Privado (tem token): o navegador pode guardar por 1 h; nenhum cache compartilhado.
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      },
      (err) => {
        // Erro depois de começar a responder (cliente desistiu no meio) não tem mais o que fazer.
        if (err && !res.headersSent) reject(err);
        else resolve();
      },
    );
  });
}
