import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { detectType, type DetectedType } from '../messaging/attachments.storage';
import { mediaBlocklist } from './media.blocklist';
import { fingerprint, processUpload } from './media.image';
import { MEDIA_MIME, mediaKeyFromParts, parseMediaWidth } from './media.paths';
import { mediaFilePath, mediaVariantPath, saveMedia } from './media.storage';

const uploadSchema = z.object({
  /** Sem o campo, vale portfólio: quem chamava a API antes do ADR 38 não recebe um recorte. */
  purpose: z.enum(['avatar', 'portfolio']).default('portfolio'),
});

const WEBP: DetectedType = { mime: 'image/webp', ext: 'webp', kind: 'image', names: ['webp'] };

/**
 * POST /api/media — imagem para avatar ou portfólio (ADR 36 e 38). O tipo vem dos primeiros bytes
 * (só imagem, nada de SVG); depois a sharp decodifica e reencoda em WebP, orientado, sem
 * metadados e no tamanho do uso. Imagem removida pela moderação é recusada, mesmo reencodada ou
 * reduzida (ADR 39). Devolve a URL pública e as dimensões finais.
 */
export async function uploadMedia(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new HttpError(422, 'Envie a imagem no campo "file"', 'file_required');
  if (req.file.buffer.length === 0) throw new HttpError(422, 'O arquivo está vazio', 'empty_file');
  const { purpose } = uploadSchema.parse(req.body ?? {});
  const type = detectType(req.file.buffer);
  if (!type || type.kind !== 'image') {
    throw new HttpError(422, 'Envie uma imagem JPG, PNG, GIF ou WebP', 'not_an_image');
  }
  const image = await processUpload(req.file.buffer, purpose);
  if (await mediaBlocklist.matches(await fingerprint(image.data))) {
    throw new HttpError(
      422,
      'Esta imagem foi removida pela moderação e não pode ser usada no Escambo',
      'image_blocked',
    );
  }
  const url = await saveMedia(image.data, WEBP);
  res.status(201).json({
    url,
    mime: WEBP.mime,
    size: image.data.length,
    width: image.width,
    height: image.height,
  });
}

const notFound = (): HttpError => new HttpError(404, 'Imagem não encontrada', 'media_not_found');

function sendImage(res: Response, abs: string, ext: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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

/**
 * GET /api/media/:year/:month/:file[?w=128|480] — pública (avatar e portfólio já são públicos). O
 * nome é um ULID que nunca muda de conteúdo, então o cache é de um ano e imutável, e a miniatura
 * herda isso. Com ?w=, a miniatura nasce na primeira leitura e fica em disco (ADR 38); se a sharp
 * não conseguir ler um original antigo, serve o original em vez de quebrar a imagem.
 */
export async function serveMedia(req: Request, res: Response): Promise<void> {
  const { year = '', month = '', file = '' } = req.params as Record<string, string | undefined>;
  const key = mediaKeyFromParts(year, month, file);
  const abs = key ? mediaFilePath(key) : null;
  if (!key || !abs) throw notFound();
  const width = parseMediaWidth(req.query.w);
  if (width === null) {
    throw new HttpError(
      400,
      'Largura de miniatura não suportada (use 128, 480 ou 960)',
      'invalid_width',
    );
  }
  if (width) {
    let variant: string | null;
    try {
      variant = await mediaVariantPath(key, width);
    } catch (err) {
      logger.warn({ err, key, width }, 'miniatura não gerada; servindo o original');
      return sendImage(res, abs, key.slice(key.lastIndexOf('.') + 1));
    }
    if (!variant) throw notFound();
    return sendImage(res, variant, 'webp');
  }
  return sendImage(res, abs, key.slice(key.lastIndexOf('.') + 1));
}
