/** Maior lado, em px, de cada uso (ADR 36 e 38): avatar recortado em quadrado, portfólio com folga. */
export const IMAGE_MAX_SIDE = { avatar: 512, portfolio: 1600 } as const;

/** Limite da API para imagens de perfil e portfólio. */
export const MEDIA_MAX_MB = 5;

/**
 * Larguras de miniatura que a API gera (ADR 38): `small` cobre o maior avatar e as prévias em tela
 * de alta densidade; `card` cobre o cartão do portfólio no perfil público.
 */
export const MEDIA_THUMB = { small: 128, card: 480 } as const;
export type MediaThumbWidth = (typeof MEDIA_THUMB)[keyof typeof MEDIA_THUMB];

const MEDIA_URL =
  /^\/api\/media\/\d{4}\/(0[1-9]|1[0-2])\/[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|gif|webp)$/;

/** Miniatura de uma imagem enviada ao Escambo; link externo (e o que não for mídia) volta igual. */
export function mediaVariant(url: string, width: MediaThumbWidth): string {
  return MEDIA_URL.test(url) ? `${url}?w=${width}` : url;
}

/** O navegador consegue abrir a foto para o recorte (createImageBitmap + canvas). */
export const canCrop = (): boolean =>
  typeof createImageBitmap === 'function' && typeof document !== 'undefined';

/** Dimensões que cabem em `max` sem distorcer e sem ampliar. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const scale = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Prepara a imagem no navegador antes de enviar: aplica a orientação da câmera, reduz para o
 * tamanho de uso e reencoda (WebP, ou JPEG onde o navegador não gera WebP) — o que também joga
 * fora EXIF com GPS. GIF vai como está (reencodar perderia a animação). Sem canvas no ambiente,
 * vai o original: a API remove os metadados de qualquer jeito.
 */
export async function prepareImage(file: File, maxSide: number): Promise<Blob> {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const encode = (type: string): Promise<Blob | null> =>
    new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
  const webp = await encode('image/webp');
  if (webp && webp.type === 'image/webp') return webp;
  return (await encode('image/jpeg')) ?? file;
}
