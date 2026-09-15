import type { PurgeAttachmentsResult } from '@escambo/types';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  purgeByRetention,
  recordPurge,
  lastPurge,
  retentionDays,
} from '../modules/messaging/attachments.purge';
import { hourInBrt, startOfTodayBrt } from './daily-digest';

/**
 * Expurgo de anexos do chat (ADR 31). Roda com os outros jobs, mas age uma vez por dia, a
 * partir de ATTACHMENT_PURGE_HOUR em Brasília (madrugada: menos gente na Sala); a trava é o
 * registro do último expurgo em platform_settings, que sobrevive a reinícios. O admin pode
 * forçar pelo painel (`force`), sem esperar a hora nem a trava.
 */

export interface PurgeOptions {
  now?: Date;
  force?: boolean;
  trigger?: 'job' | 'admin';
}

export async function runPurgeAttachments(
  opts: PurgeOptions = {},
): Promise<PurgeAttachmentsResult> {
  const now = opts.now ?? new Date();
  const skip = async (
    reason: NonNullable<PurgeAttachmentsResult['skipped']>,
  ): Promise<PurgeAttachmentsResult> => ({
    retentionDays: await retentionDays(),
    cutoff: null,
    purged: 0,
    orphansRemoved: 0,
    failed: 0,
    skipped: reason,
  });

  if (!opts.force) {
    if (hourInBrt(now) < env.ATTACHMENT_PURGE_HOUR) return skip('before_hour');
    const last = await lastPurge();
    if (last && new Date(last.at) >= startOfTodayBrt(now)) return skip('already_today');
  }

  const summary = await purgeByRetention(now);
  await recordPurge({
    at: now.toISOString(),
    purged: summary.purged,
    orphansRemoved: summary.orphansRemoved,
    trigger: opts.trigger ?? 'job',
  });
  if (summary.purged || summary.orphansRemoved || summary.failed) {
    logger.info(summary, 'expurgo de anexos concluído');
  }
  return { ...summary, skipped: null };
}
