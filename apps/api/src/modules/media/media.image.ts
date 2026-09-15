import type { MediaPurpose } from '@escambo/types';
import sharp from 'sharp';
import { HttpError } from '../../utils/http-error';

/**
 * Processamento das imagens de perfil e portfólio (ADR 38). A API decodifica e reencoda tudo em
 * WebP com a sharp (libvips): aplica a orientação da câmera, descarta EXIF, XMP, ICC e comentários
 * e garante as dimensões. O avatar sai quadrado (recortado no centro quando ninguém recortou antes)
 * e nada é ampliado. Imagem animada só continua animada no portfólio. O limite de pixels barra as
 * "bombas de descompressão": um arquivo de poucos KB que abriria em gigabytes de memória.
 */

export const AVATAR_SIDE = 512;
export const PORTFOLIO_MAX_SIDE = 1600;
/** 50 megapixels: sobra para foto de câmera e barra imagem montada para estourar a memória. */
export const MAX_INPUT_PIXELS = 50_000_000;
const WEBP_QUALITY = 82;

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
  animated: boolean;
}

function unreadable(err: unknown): HttpError {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('pixel limit')) {
    return new HttpError(
      422,
      'A imagem tem pixels demais; envie uma foto menor',
      'image_too_large',
    );
  }
  return new HttpError(422, 'Não foi possível ler a imagem; envie outro arquivo', 'invalid_image');
}

/** Envio: decodifica, orienta, ajusta ao uso e reencoda em WebP sem metadados. */
export async function processUpload(bytes: Buffer, purpose: MediaPurpose): Promise<ProcessedImage> {
  try {
    const canAnimate = purpose === 'portfolio';
    const meta = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: canAnimate,
    }).metadata();
    const animated = canAnimate && (meta.pages ?? 1) > 1;
    let img = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated });
    if (!animated) img = img.autoOrient();
    if (purpose === 'avatar') {
      const width = meta.autoOrient?.width ?? meta.width ?? AVATAR_SIDE;
      const height = meta.autoOrient?.height ?? meta.pageHeight ?? meta.height ?? AVATAR_SIDE;
      const side = Math.max(1, Math.min(AVATAR_SIDE, width, height));
      img = img.resize(side, side, { fit: 'cover', position: 'centre' });
    } else {
      img = img.resize(PORTFOLIO_MAX_SIDE, PORTFOLIO_MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const { data, info } = await img
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.pageHeight ?? info.height, animated };
  } catch (err) {
    throw unreadable(err);
  }
}

/**
 * Miniatura de um original já gravado (inclusive os enviados antes do ADR 38): cabe num quadrado
 * de `width` px sem distorcer nem ampliar, e animada continua animada.
 */
export async function makeVariant(original: Buffer, width: number): Promise<Buffer> {
  const meta = await sharp(original, {
    limitInputPixels: MAX_INPUT_PIXELS,
    animated: true,
  }).metadata();
  const animated = (meta.pages ?? 1) > 1;
  let img = sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, animated });
  if (!animated) img = img.autoOrient();
  return img
    .resize(width, width, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}
