/**
 * Endereços das imagens de perfil e portfólio (ADR 36 e 38): /api/media/AAAA/MM/<ULID>.<ext>. O
 * nome é gerado pela API (ULID em base32 de Crockford, maiúsculo), então a validação é estrita:
 * nada de caminho relativo, ponto-ponto ou extensão fora das imagens aceitas. Miniatura não tem
 * URL própria gravada em lugar nenhum: é a mesma URL com ?w= (lista fechada de larguras) e fica em
 * disco ao lado do original, como <ULID>.w<largura>.webp.
 */

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const EXT = '(?:jpg|png|gif|webp)';

/** URL pública completa, como fica gravada no perfil. */
export const MEDIA_URL_RE = new RegExp(`^/api/media/(\\d{4})/(0[1-9]|1[0-2])/(${ULID}\\.${EXT})$`);

/** Só o nome do arquivo (último segmento da URL). */
export const MEDIA_FILE_RE = new RegExp(`^${ULID}\\.(jpg|png|gif|webp)$`);

/**
 * Larguras de miniatura aceitas em ?w=: avatar em listas e cartão do portfólio (ADR 38) e a imagem
 * da galeria em telas pequenas (ADR 40).
 */
export const MEDIA_WIDTHS = [128, 480, 960] as const;
export type MediaWidth = (typeof MEDIA_WIDTHS)[number];

const ORIGINAL_FILE_RE = new RegExp(`^(${ULID})\\.(?:jpg|png|gif|webp)$`);
const VARIANT_FILE_RE = new RegExp(`^(${ULID})\\.w(\\d+)\\.webp$`);

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

/**
 * ?w= da leitura → largura aceita; undefined sem ?w=; null se veio qualquer outra coisa (outro
 * número, zero à esquerda, repetido). A grafia exata evita duas URLs para a mesma miniatura.
 */
export function parseMediaWidth(raw: unknown): MediaWidth | null | undefined {
  if (raw === undefined) return undefined;
  const match = MEDIA_WIDTHS.find((w) => String(w) === raw);
  return match ?? null;
}

/** Chave do original → chave da miniatura, na mesma pasta. */
export function mediaVariantKey(key: string, width: MediaWidth): string {
  const slash = key.lastIndexOf('/');
  const file = key.slice(slash + 1);
  const id = file.slice(0, file.indexOf('.'));
  return `${key.slice(0, slash + 1)}${id}.w${width}.webp`;
}

/**
 * Identidade de um arquivo em disco (AAAA/MM/<ULID>), a mesma para o original e as miniaturas, e
 * se é miniatura. null para o que não é mídia (temporário de uma geração interrompida, lixo).
 */
export function mediaIdOf(key: string): { id: string; variant: boolean } | null {
  const slash = key.lastIndexOf('/');
  const dir = key.slice(0, slash + 1);
  const file = key.slice(slash + 1);
  const original = ORIGINAL_FILE_RE.exec(file);
  if (original) return { id: `${dir}${original[1]}`, variant: false };
  const variant = VARIANT_FILE_RE.exec(file);
  return variant ? { id: `${dir}${variant[1]}`, variant: true } : null;
}
