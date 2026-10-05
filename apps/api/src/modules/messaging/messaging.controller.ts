import path from 'node:path';
import type { Request, Response } from 'express';
import { HttpError } from '../../utils/http-error';
import { uploadsDir } from './attachments.storage';
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
  // Relativo à pasta de uploads (opção root): o dotfiles: 'deny' olha só o caminho dentro dela, e
  // não recusa todo download quando o DATA_DIR mora numa pasta começada por ponto.
  const root = uploadsDir();
  await new Promise<void>((resolve, reject) => {
    res.sendFile(
      path.relative(root, file.path),
      {
        root,
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
        if (!err || res.headersSent) return resolve();
        // O arquivo saiu do disco entre a checagem do service e o envio (expurgo ao mesmo tempo):
        // é o mesmo 404 do caminho normal, não falha do servidor.
        const status = (err as { status?: number }).status;
        const code = (err as NodeJS.ErrnoException).code;
        reject(
          status === 404 || code === 'ENOENT'
            ? new HttpError(
                404,
                'O arquivo deste anexo não está mais disponível',
                'attachment_missing',
              )
            : err,
        );
      },
    );
  });
}
