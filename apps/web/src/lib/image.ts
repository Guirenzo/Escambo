/** Maior lado, em px, de cada uso (ADR 36): avatar pequeno, portfólio com folga para a galeria. */
export const IMAGE_MAX_SIDE = { avatar: 512, portfolio: 1600 } as const;

/** Limite da API para imagens de perfil e portfólio. */
export const MEDIA_MAX_MB = 5;

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
