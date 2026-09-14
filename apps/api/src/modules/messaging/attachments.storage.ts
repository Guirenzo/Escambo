import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { env } from '../../config/env';

/**
 * Armazenamento dos anexos do chat (ADR 29): disco local em DATA_DIR/uploads (volume no Docker),
 * um arquivo por mensagem, chave gerada aqui (nunca o nome que veio do cliente). O tipo é
 * reconhecido pelo CONTEÚDO — os primeiros bytes — e o Content-Type declarado é ignorado: é a
 * única defesa honesta contra "foto.png" que na verdade é um HTML.
 */

export type AttachmentKind = 'image' | 'file';

export interface DetectedType {
  mime: string;
  /** Extensão com que o arquivo é guardado (derivada do tipo real). */
  ext: string;
  kind: AttachmentKind;
  /** Extensões que o nome de download pode ter para este tipo (docx/xlsx… são ZIPs). */
  names: readonly string[];
}

const startsWith = (b: Buffer, ascii: string, at = 0): boolean =>
  b.length >= at + ascii.length && b.subarray(at, at + ascii.length).toString('latin1') === ascii;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tipos aceitos e como reconhecê-los. SVG fica de fora de propósito (roda script). */
const SIGNATURES: ReadonlyArray<{ match: (b: Buffer) => boolean; type: DetectedType }> = [
  {
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    type: { mime: 'image/jpeg', ext: 'jpg', kind: 'image', names: ['jpg', 'jpeg'] },
  },
  {
    match: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC),
    type: { mime: 'image/png', ext: 'png', kind: 'image', names: ['png'] },
  },
  {
    match: (b) => startsWith(b, 'GIF87a') || startsWith(b, 'GIF89a'),
    type: { mime: 'image/gif', ext: 'gif', kind: 'image', names: ['gif'] },
  },
  {
    match: (b) => startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8),
    type: { mime: 'image/webp', ext: 'webp', kind: 'image', names: ['webp'] },
  },
  {
    match: (b) => startsWith(b, '%PDF-'),
    type: { mime: 'application/pdf', ext: 'pdf', kind: 'file', names: ['pdf'] },
  },
  {
    // PK 03 04 (entrada), PK 05 06 (zip vazio) ou PK 07 08 (spanned).
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x50 &&
      b[1] === 0x4b &&
      ((b[2] === 0x03 && b[3] === 0x04) ||
        (b[2] === 0x05 && b[3] === 0x06) ||
        (b[2] === 0x07 && b[3] === 0x08)),
    type: {
      mime: 'application/zip',
      ext: 'zip',
      kind: 'file',
      names: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
    },
  },
];

/** MIME types aceitos (para o `accept` do input e a documentação). */
export const ACCEPTED_MIMES: readonly string[] = SIGNATURES.map((s) => s.type.mime);

/** Reconhece o tipo pelos primeiros bytes; null = não é um dos tipos aceitos. */
export function detectType(bytes: Buffer): DetectedType | null {
  return SIGNATURES.find((s) => s.match(bytes))?.type ?? null;
}

const NAME_MAX = 120;
// Caracteres de controle (0x00–0x1f, 0x7f) e aspas: fora do nome de download.
const UNSAFE_NAME_CHARS = /[\p{Cc}"]/gu;

/**
 * Nome de download seguro: só o nome-base (sem caminho), sem caracteres de controle nem aspas,
 * espaços normalizados, no máximo 120 caracteres — e com uma extensão coerente com o tipo real
 * (um PNG chamado "foto.exe" baixa como "foto.exe.png").
 */
export function safeFileName(original: string | undefined, type: DetectedType): string {
  const base = (original ?? '')
    .normalize('NFC')
    .split(/[\\/]/)
    .pop()!
    .replace(UNSAFE_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  let name = base || `arquivo.${type.ext}`;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!type.names.includes(ext)) name = `${name}.${type.ext}`;
  if (name.length > NAME_MAX) {
    const tail = name.slice(name.lastIndexOf('.'));
    name = `${name.slice(0, NAME_MAX - tail.length)}${tail}`;
  }
  return name;
}

/** Content-Disposition com o nome em ASCII (fallback) e em UTF-8 (RFC 5987). */
export function contentDisposition(kind: AttachmentKind, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const disposition = kind === 'image' ? 'inline' : 'attachment';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// ---------- disco ----------

const uploadsDir = (): string => path.resolve(env.DATA_DIR, 'uploads');

/** Caminho absoluto de uma chave, ou null se ela tentar sair da pasta de uploads. */
export function attachmentPath(key: string): string | null {
  const root = uploadsDir();
  const abs = path.resolve(root, key);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** Grava o arquivo em uploads/AAAA/MM/<ulid>.<ext> e devolve a chave (relativa à pasta). */
export async function saveAttachment(bytes: Buffer, type: DetectedType): Promise<string> {
  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `${dir}/${ulid()}.${type.ext}`;
  await mkdir(path.join(uploadsDir(), dir), { recursive: true });
  await writeFile(attachmentPath(key)!, bytes, { flag: 'wx' });
  return key;
}

/** Remove o arquivo (best-effort: já não existir não é erro). */
export async function removeAttachment(key: string): Promise<void> {
  const abs = attachmentPath(key);
  if (!abs) return;
  await unlink(abs).catch(() => undefined);
}

/** Tamanho em disco, ou null se o arquivo sumiu (volume perdido, restauração incompleta). */
export async function attachmentSize(key: string): Promise<number | null> {
  const abs = attachmentPath(key);
  if (!abs) return null;
  try {
    return (await stat(abs)).size;
  } catch {
    return null;
  }
}
