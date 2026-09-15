import { unlink } from 'node:fs/promises';
import type { AdminStorage } from '@escambo/types';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { settingsRepository } from '../settings/settings.repository';
import { dataDirUsage, listUploadedFiles, removeAttachment } from './attachments.storage';
import { messagingRepository } from './messaging.repository';

/**
 * Expurgo de anexos do chat (ADR 31). O arquivo é o que pesa e o que carrega dado pessoal; a
 * mensagem fica e passa a dizer por que o arquivo sumiu. Três caminhos:
 *  - retenção: anexo com mais de N dias numa conversa sem contratação aberta entre as duas
 *    pessoas (N = platform_settings.attachment_retention_days);
 *  - LGPD: tudo que um titular anonimizado enviou sai na hora;
 *  - órfãos: arquivo no disco sem linha no banco (upload interrompido), com mais de 24 h.
 */

export const DEFAULT_RETENTION_DAYS = 180;
/** Anexos por rodada: o job roda todo dia, então uma rodada grande não é necessária. */
export const PURGE_BATCH = 500;
/** Arquivo sem linha só é órfão de verdade depois de um dia (upload em andamento tem linha logo). */
export const ORPHAN_GRACE_MS = 24 * 3_600_000;
export const LAST_PURGE_KEY = 'attachment_last_purge';

export interface PurgeSummary {
  retentionDays: number;
  cutoff: string;
  purged: number;
  orphansRemoved: number;
  failed: number;
}

export type LastPurge = NonNullable<AdminStorage['lastPurge']>;

export const retentionDays = (): Promise<number> =>
  settingsRepository.getNumber('attachment_retention_days', DEFAULT_RETENTION_DAYS);

/** Anexos vencidos pela retenção: arquivo apagado, linha marcada; falha em um não para os outros. */
export async function purgeByRetention(now: Date = new Date()): Promise<PurgeSummary> {
  const days = await retentionDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = await messagingRepository.listPurgeable(cutoff, PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await removeAttachment(row.file_url);
      await messagingRepository.markPurged(row.id, 'retention');
      purged++;
    } catch (err) {
      failed++;
      logger.error({ err, messageId: row.id }, 'expurgo: falha ao remover anexo');
    }
  }
  const orphansRemoved = await removeOrphans(now);
  return { retentionDays: days, cutoff: cutoff.toISOString(), purged, orphansRemoved, failed };
}

/** Tudo que um titular enviou no chat (LGPD): arquivos fora do disco, linhas marcadas. */
export async function purgeForUser(userId: number): Promise<number> {
  const rows = await messagingRepository.listUserAttachments(userId);
  for (const row of rows) {
    await removeAttachment(row.file_url);
    await messagingRepository.markPurged(row.id, 'lgpd');
  }
  return rows.length;
}

/** Arquivos no disco que nenhuma linha referencia há mais de ORPHAN_GRACE_MS. */
export async function removeOrphans(now: Date = new Date()): Promise<number> {
  const files = await listUploadedFiles();
  if (files.length === 0) return 0;
  const known = new Set(await messagingRepository.listAttachmentKeys());
  let removed = 0;
  for (const file of files) {
    if (known.has(file.key) || now.getTime() - file.mtimeMs < ORPHAN_GRACE_MS) continue;
    await unlink(file.path).catch(() => undefined);
    removed++;
  }
  return removed;
}

export async function lastPurge(): Promise<LastPurge | null> {
  const raw = await settingsRepository.get(LAST_PURGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastPurge;
  } catch {
    return null;
  }
}

export async function recordPurge(entry: LastPurge): Promise<void> {
  await settingsRepository.set(LAST_PURGE_KEY, JSON.stringify(entry), 'json');
}

/** Uso do volume e saúde dos anexos, para o painel admin. */
export async function storageReport(): Promise<AdminStorage> {
  const [uploads, exports, stats, keys, files, last, days] = await Promise.all([
    dataDirUsage('uploads'),
    dataDirUsage('exports'),
    messagingRepository.attachmentStats(),
    messagingRepository.listAttachmentKeys(),
    listUploadedFiles(),
    lastPurge(),
    retentionDays(),
  ]);
  const onDisk = new Set(files.map((f) => f.key));
  const known = new Set(keys);
  return {
    retentionDays: days,
    purgeHour: env.ATTACHMENT_PURGE_HOUR,
    uploads,
    exports,
    attachments: {
      ...stats,
      missing: keys.filter((k) => !onDisk.has(k)).length,
      orphans: files.filter((f) => !known.has(f.key)).length,
    },
    lastPurge: last,
  };
}
