import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { env } from '../../config/env';
import type { DetectedType } from '../messaging/attachments.storage';
import { makeVariant } from './media.image';
import {
  mediaIdOf,
  mediaKeyFromUrl,
  mediaUrl,
  mediaVariantKey,
  type MediaWidth,
} from './media.paths';
import { mediaRepository } from './media.repository';

/**
 * Imagens de perfil e portfólio (ADR 36 e 38) em DATA_DIR/media/AAAA/MM/<ULID>.<ext>, no mesmo
 * volume dos anexos do chat mas numa pasta própria: estas são públicas, aquelas não. Miniaturas
 * nascem na primeira leitura com ?w= e ficam ao lado do original (<ULID>.w<largura>.webp). Imagem
 * enviada e não usada (troca de foto, formulário abandonado, conta anonimizada) vira órfã e sai no
 * expurgo depois de um dia, junto com as miniaturas dela.
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

/** Grava a imagem (já processada) e devolve a URL pública. */
export async function saveMedia(bytes: Buffer, type: DetectedType): Promise<string> {
  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `${dir}/${ulid()}.${type.ext}`;
  await mkdir(path.join(mediaDir(), dir), { recursive: true });
  await writeFile(mediaFilePath(key)!, bytes, { flag: 'wx' });
  return mediaUrl(key);
}

const exists = (abs: string): Promise<boolean> =>
  stat(abs).then(
    () => true,
    () => false,
  );

/**
 * Grava num temporário e renomeia: quem lê ao mesmo tempo nunca vê arquivo pela metade. Se outro
 * pedido já gravou a mesma miniatura (no Windows o rename falha com o destino aberto), vale a dele.
 */
async function writeAtomic(abs: string, bytes: Buffer): Promise<void> {
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    if (!(await exists(abs))) throw err;
  }
}

/** Gerações em andamento: pedidos simultâneos da mesma miniatura esperam a mesma. */
const pending = new Map<string, Promise<string>>();

/**
 * Caminho da miniatura de um original, gerada na primeira leitura (ADR 38). null quando o original
 * não existe (404). Erro da sharp sobe para quem chamou decidir (a leitura serve o original).
 */
export async function mediaVariantPath(key: string, width: MediaWidth): Promise<string | null> {
  const variantKey = mediaVariantKey(key, width);
  const abs = mediaFilePath(variantKey);
  const source = mediaFilePath(key);
  if (!abs || !source) return null;
  if (await exists(abs)) return abs;
  let job = pending.get(variantKey);
  if (!job) {
    job = (async () => {
      const original = await readFile(source);
      await writeAtomic(abs, await makeVariant(original, width));
      return abs;
    })().finally(() => pending.delete(variantKey));
    pending.set(variantKey, job);
  }
  try {
    return await job;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

interface MediaFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** AAAA/MM/<ULID>, igual para o original e as miniaturas; null para o que não é mídia. */
  id: string | null;
  variant: boolean;
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
    const st = await stat(abs).catch(() => null);
    if (!st) continue; // sumiu entre a listagem e o stat (outro expurgo, rename)
    const identity = mediaIdOf(path.relative(root, abs).split(path.sep).join('/'));
    files.push({
      path: abs,
      size: st.size,
      mtimeMs: st.mtimeMs,
      id: identity?.id ?? null,
      variant: identity?.variant ?? false,
    });
  }
  return files;
}

/** Identidades (AAAA/MM/<ULID>) das imagens que algum perfil ou portfólio usa. */
async function referencedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const url of await mediaRepository.listReferencedUrls()) {
    const key = mediaKeyFromUrl(url);
    const identity = key ? mediaIdOf(key) : null;
    if (identity) ids.add(identity.id);
  }
  return ids;
}

/** Uso da pasta de mídia (painel admin): imagens, miniaturas, espaço e imagens que ninguém usa. */
export async function mediaUsage(): Promise<{
  files: number;
  variants: number;
  bytes: number;
  orphans: number;
}> {
  const files = await listMediaFiles();
  if (files.length === 0) return { files: 0, variants: 0, bytes: 0, orphans: 0 };
  const referenced = await referencedIds();
  const originals = files.filter((f) => f.id && !f.variant);
  return {
    files: originals.length,
    variants: files.filter((f) => f.id && f.variant).length,
    bytes: files.reduce((acc, f) => acc + f.size, 0),
    orphans: originals.filter((f) => !referenced.has(f.id!)).length,
  };
}

/**
 * Apaga as imagens que nenhum perfil ou portfólio usa há mais de um dia, com as miniaturas delas,
 * e temporários largados por uma geração interrompida. Devolve quantas imagens saíram.
 */
export async function removeMediaOrphans(now: Date = new Date()): Promise<number> {
  const files = await listMediaFiles();
  if (files.length === 0) return 0;
  const referenced = await referencedIds();
  const expired = (f: MediaFile): boolean => now.getTime() - f.mtimeMs >= MEDIA_ORPHAN_GRACE_MS;
  const groups = new Map<string, MediaFile[]>();
  for (const f of files) {
    if (!f.id) {
      if (expired(f)) await unlink(f.path).catch(() => undefined);
      continue;
    }
    groups.set(f.id, [...(groups.get(f.id) ?? []), f]);
  }
  let removed = 0;
  for (const [id, group] of groups) {
    if (referenced.has(id)) continue;
    // O prazo conta do envio (o original); miniatura sem original já é sobra.
    const original = group.find((f) => !f.variant);
    if (original && !expired(original)) continue;
    for (const f of group) await unlink(f.path).catch(() => undefined);
    removed++;
  }
  return removed;
}
