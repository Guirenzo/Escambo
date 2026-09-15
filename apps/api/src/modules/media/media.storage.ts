import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { env } from '../../config/env';
import type { DetectedType } from '../messaging/attachments.storage';
import { mediaKeyFromUrl, mediaUrl } from './media.paths';
import { mediaRepository } from './media.repository';

/**
 * Imagens de perfil e portfólio (ADR 36) em DATA_DIR/media/AAAA/MM/<ULID>.<ext>, no mesmo volume
 * dos anexos do chat mas numa pasta própria: estas são públicas, aquelas não. Imagem enviada e
 * não usada (troca de foto, formulário abandonado, conta anonimizada) vira órfã e sai no expurgo
 * depois de um dia.
 */

export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_ORPHAN_GRACE_MS = 24 * 3_600_000;

export const mediaDir = (): string => path.resolve(env.DATA_DIR, 'media');

/** Caminho absoluto de uma chave, ou null se ela tentar sair da pasta de mídia. */
export function mediaFilePath(key: string): string | null {
  const root = mediaDir();
  const abs = path.resolve(root, key);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** Grava a imagem (já sem metadados) e devolve a URL pública. */
export async function saveMedia(bytes: Buffer, type: DetectedType): Promise<string> {
  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `${dir}/${ulid()}.${type.ext}`;
  await mkdir(path.join(mediaDir(), dir), { recursive: true });
  await writeFile(mediaFilePath(key)!, bytes, { flag: 'wx' });
  return mediaUrl(key);
}

interface MediaFile {
  key: string;
  path: string;
  size: number;
  mtimeMs: number;
}

async function listMediaFiles(): Promise<MediaFile[]> {
  const root = mediaDir();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const files: MediaFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const st = await stat(abs);
    files.push({
      key: path.relative(root, abs).split(path.sep).join('/'),
      path: abs,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  return files;
}

async function referencedKeys(): Promise<Set<string>> {
  const keys = (await mediaRepository.listReferencedUrls())
    .map(mediaKeyFromUrl)
    .filter((k): k is string => k !== null);
  return new Set(keys);
}

/** Uso da pasta de mídia e quantas imagens ninguém referencia (painel admin). */
export async function mediaUsage(): Promise<{ files: number; bytes: number; orphans: number }> {
  const files = await listMediaFiles();
  if (files.length === 0) return { files: 0, bytes: 0, orphans: 0 };
  const referenced = await referencedKeys();
  return {
    files: files.length,
    bytes: files.reduce((acc, f) => acc + f.size, 0),
    orphans: files.filter((f) => !referenced.has(f.key)).length,
  };
}

/** Apaga imagens que nenhum perfil ou portfólio usa há mais de um dia. */
export async function removeMediaOrphans(now: Date = new Date()): Promise<number> {
  const files = await listMediaFiles();
  if (files.length === 0) return 0;
  const referenced = await referencedKeys();
  let removed = 0;
  for (const file of files) {
    if (referenced.has(file.key) || now.getTime() - file.mtimeMs < MEDIA_ORPHAN_GRACE_MS) continue;
    await unlink(file.path).catch(() => undefined);
    removed++;
  }
  return removed;
}
