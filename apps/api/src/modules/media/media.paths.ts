/**
 * Endereços das imagens de perfil e portfólio (ADR 36): /api/media/AAAA/MM/<ULID>.<ext>. O nome
 * é gerado pela API (ULID em base32 de Crockford, maiúsculo), então a validação é estrita: nada
 * de caminho relativo, ponto-ponto ou extensão fora das imagens aceitas.
 */

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const EXT = '(?:jpg|png|gif|webp)';

/** URL pública completa, como fica gravada no perfil. */
export const MEDIA_URL_RE = new RegExp(`^/api/media/(\\d{4})/(0[1-9]|1[0-2])/(${ULID}\\.${EXT})$`);

/** Só o nome do arquivo (último segmento da URL). */
export const MEDIA_FILE_RE = new RegExp(`^${ULID}\\.(jpg|png|gif|webp)$`);

export const MEDIA_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Chave em disco (AAAA/MM/<arquivo>) → URL pública. */
export const mediaUrl = (key: string): string => `/api/media/${key}`;

/** URL pública → chave em disco; null se não for uma URL de mídia válida. */
export function mediaKeyFromUrl(url: string | null | undefined): string | null {
  const m = MEDIA_URL_RE.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

/** Partes da rota GET /api/media/:year/:month/:file → chave, ou null se algo não bate. */
export function mediaKeyFromParts(year: string, month: string, file: string): string | null {
  return mediaKeyFromUrl(`/api/media/${year}/${month}/${file}`);
}
