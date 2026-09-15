import type { Request, Response } from 'express';
import { HttpError } from '../../utils/http-error';
import { detectType } from '../messaging/attachments.storage';
import { MEDIA_MIME, mediaKeyFromParts } from './media.paths';
import { mediaFilePath, saveMedia } from './media.storage';
import { stripImageMetadata } from './media.strip';

/** POST /api/media — imagem para avatar ou portfólio (ADR 36); devolve a URL pública. */
export async function uploadMedia(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new HttpError(422, 'Envie a imagem no campo "file"', 'file_required');
  if (req.file.buffer.length === 0) throw new HttpError(422, 'O arquivo está vazio', 'empty_file');
  // Tipo pelos primeiros bytes, como nos anexos do chat — mas aqui só imagem.
  const type = detectType(req.file.buffer);
  if (!type || type.kind !== 'image') {
    throw new HttpError(422, 'Envie uma imagem JPG, PNG, GIF ou WebP', 'not_an_image');
  }
  const clean = stripImageMetadata(req.file.buffer, type.mime);
  const url = await saveMedia(clean, type);
  res.status(201).json({ url, mime: type.mime, size: clean.length });
}

const notFound = (): HttpError => new HttpError(404, 'Imagem não encontrada', 'media_not_found');

/**
 * GET /api/media/:year/:month/:file — pública (avatar e portfólio já são públicos). O nome é um
 * ULID que nunca muda de conteúdo, então o cache é de um ano e imutável.
 */
export async function serveMedia(req: Request, res: Response): Promise<void> {
  const { year = '', month = '', file = '' } = req.params as Record<string, string | undefined>;
  const key = mediaKeyFromParts(year, month, file);
  const abs = key ? mediaFilePath(key) : null;
  if (!key || !abs) throw notFound();
  const ext = key.slice(key.lastIndexOf('.') + 1);
  await new Promise<void>((resolve, reject) => {
    res.sendFile(
      abs,
      {
        dotfiles: 'deny',
        cacheControl: false,
        headers: {
          'Content-Type': MEDIA_MIME[ext]!,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Disposition': 'inline',
          'X-Content-Type-Options': 'nosniff',
        },
      },
      (err) => {
        if (!err || res.headersSent) return resolve();
        const status = (err as { status?: number; statusCode?: number }).status;
        const code = (err as NodeJS.ErrnoException).code;
        reject(status === 404 || code === 'ENOENT' ? notFound() : err);
      },
    );
  });
}
