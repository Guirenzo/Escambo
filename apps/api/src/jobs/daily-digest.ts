import { env } from '../config/env';
import { logger } from '../config/logger';
import { mailService } from '../modules/mail/mail.service';
import { notificationsRepository } from '../modules/notifications/notifications.repository';
import { notificationsService } from '../modules/notifications/notifications.service';

/**
 * Resumo diário de notificações (ADR 27) para quem escolheu "resumo diário" no perfil.
 * Roda com os outros jobs (a cada JOBS_INTERVAL_MS) e só age a partir de DIGEST_HOUR em
 * Brasília; cada usuário recebe no máximo um resumo por dia (last_digest_at é a trava), com as
 * notificações desde o resumo anterior. Sem novidades, o dia é marcado sem enviar nada.
 */

const BRT_OFFSET_HOURS = 3;

export interface DailyDigestResult {
  skipped: 'mail_off' | 'before_hour' | null;
  sent: number[];
  empty: number[];
  failed: number[];
}

/** Hora do dia em Brasília (o país não tem horário de verão). */
export const hourInBrt = (now: Date): number => (now.getUTCHours() - BRT_OFFSET_HOURS + 24) % 24;

/** Começo do dia de hoje em Brasília, como instante UTC. */
export function startOfTodayBrt(now: Date): Date {
  const brt = new Date(now.getTime() - BRT_OFFSET_HOURS * 3_600_000);
  return new Date(
    Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate(), BRT_OFFSET_HOURS, 0, 0),
  );
}

export async function runDailyDigest(now: Date = new Date()): Promise<DailyDigestResult> {
  const result: DailyDigestResult = { skipped: null, sent: [], empty: [], failed: [] };
  if (!mailService.enabled()) return { ...result, skipped: 'mail_off' };
  if (hourInBrt(now) < env.DIGEST_HOUR) return { ...result, skipped: 'before_hour' };

  for (const user of await notificationsRepository.usersForDigest(startOfTodayBrt(now))) {
    try {
      const count = await notificationsService.sendDigest(user, now);
      (count > 0 ? result.sent : result.empty).push(user.id);
    } catch (err) {
      result.failed.push(user.id);
      logger.error({ userId: user.id, err }, 'falha no resumo diário');
    }
  }
  return result;
}
