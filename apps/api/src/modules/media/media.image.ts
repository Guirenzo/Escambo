import { createHash } from 'node:crypto';
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
/** Até quantos bits diferentes duas impressões perceptuais contam como a mesma imagem (ADR 39). */
export const PERCEPTUAL_MATCH_BITS = 6;

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
 * Impressão perceptual de 64 bits (dHash, ADR 39): a imagem vira 9 × 8 tons de cinza e cada bit diz
 * se um ponto é mais claro que o vizinho da direita. Reencodar, comprimir ou reduzir mexe em poucos
 * bits; outra foto mexe em muitos.
 */
export async function perceptualHash(bytes: Buffer): Promise<bigint> {
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const step = info.channels;
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * step;
      hash = (hash << 1n) | (data[i]! > data[i + step]! ? 1n : 0n);
    }
  }
  return hash;
}

/** Quantos bits diferem entre duas impressões. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let bits = 0;
  while (x > 0n) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits;
}

/**
 * Imagem quase lisa gera impressão quase toda zero (ou um) e parece com qualquer outra lisa, então
 * não serve para comparar: para ela vale só a assinatura exata do arquivo.
 */
export function isInformativeHash(hash: bigint): boolean {
  const bits = hammingDistance(hash, 0n);
  return bits >= 8 && bits <= 56;
}

export interface ImageFingerprint {
  sha256: string;
  /** null quando a imagem não tem detalhe suficiente para comparação perceptual. */
  dhash: bigint | null;
}

/** Assinatura exata do arquivo e, se a imagem tiver detalhe, a impressão perceptual. */
export async function fingerprint(bytes: Buffer): Promise<ImageFingerprint> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const hash = await perceptualHash(bytes).catch(() => null);
  return { sha256, dhash: hash !== null && isInformativeHash(hash) ? hash : null };
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
