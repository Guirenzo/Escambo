import { env } from '../config/env';
import { logger } from '../config/logger';
import { mailService } from '../modules/mail/mail.service';
import { notificationsRepository } from '../modules/notifications/notifications.repository';
import { notificationsService } from '../modules/notifications/notifications.service';
import { BRAZIL_TIMEZONES, DEFAULT_TIMEZONE, hourIn, startOfTodayIn } from '../utils/timezone';

/**
 * Resumo diário de notificações (ADR 27) para quem escolheu "resumo diário" no perfil.
 * Roda com os outros jobs (a cada JOBS_INTERVAL_MS) e cada pessoa entra a partir da própria hora
 * (digest_hour, ou DIGEST_HOUR para quem não escolheu, ADR 42) no próprio fuso (timezone, ou
 * Brasília, ADR 46). Cada uma recebe no máximo um resumo por dia local (last_digest_at é a trava),
 * com as notificações desde o resumo anterior; trocar a hora depois de receber não gera outro no
 * mesmo dia. Sem novidades, o dia é marcado sem enviar nada.
 */

export interface DailyDigestResult {
  skipped: 'mail_off' | null;
  sent: number[];
  empty: number[];
  failed: number[];
}

/** Hora do dia em Brasília, o fuso padrão da plataforma (jobs com hora única, como o expurgo). */
export const hourInBrt = (now: Date): number => hourIn(DEFAULT_TIMEZONE, now);

/** Começo do dia de hoje em Brasília, como instante UTC. */
export const startOfTodayBrt = (now: Date): Date => startOfTodayIn(DEFAULT_TIMEZONE, now);

export async function runDailyDigest(now: Date = new Date()): Promise<DailyDigestResult> {
  const result: DailyDigestResult = { skipped: null, sent: [], empty: [], failed: [] };
  if (!mailService.enabled()) return { ...result, skipped: 'mail_off' };

  // Um fuso por vez: o "hoje" e a hora de cada pessoa são os do fuso dela.
  for (const zone of BRAZIL_TIMEZONES) {
    const due = await notificationsRepository.usersForDigest(
      startOfTodayIn(zone, now),
      hourIn(zone, now),
      env.DIGEST_HOUR,
      zone,
    );
    for (const user of due) {
      try {
        const count = await notificationsService.sendDigest(user, now);
        (count > 0 ? result.sent : result.empty).push(user.id);
      } catch (err) {
        result.failed.push(user.id);
        logger.error({ userId: user.id, err }, 'falha no resumo diário');
      }
    }
  }
  return result;
}
