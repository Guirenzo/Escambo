import { env } from '../config/env';
import { logger } from '../config/logger';
import { notificationsRepository } from '../modules/notifications/notifications.repository';
import { toNotification } from '../modules/notifications/notifications.service';
import {
  buildPayload,
  pushService,
  quietSummaryPayload,
} from '../modules/notifications/push.service';
import { pushTtlSeconds, quietWindowOf } from '../modules/notifications/quiet-hours';
import { BRAZIL_TIMEZONES, hourIn, timezoneOf } from '../utils/timezone';

/**
 * Resumo ao fim do silêncio (ADR 54). Roda com os outros jobs; a cada rodada, um fuso por vez,
 * procura quem está fora da própria janela de silêncio agora e tem aviso retido por resumir
 * (notifications.push_held_at acima da marca users.push_quiet_summary_id). Cada pessoa recebe um
 * push só: o próprio aviso, se ficou um; um resumo com os títulos, se ficaram vários. A trava é
 * gravada ANTES do envio, por compare-and-set na marca: com duas instâncias as duas calculam o
 * mesmo `until` e só uma passa. Entrega no máximo uma vez — um soluço do serviço de push entre a
 * trava e o envio perde aquele resumo, e a lista de notificações continua sendo o registro.
 */

export interface QuietPushSummaryResult {
  skipped: 'push_off' | null;
  sent: number[];
  /** Resumo montado e marca avançada, mas nenhum aparelho para receber (ou todos mortos). */
  unreachable: number[];
  /** Tudo lido entre a consulta e agora: nada a resumir, marca intacta. */
  empty: number[];
  failed: number[];
}

export async function runQuietPushSummary(now: Date = new Date()): Promise<QuietPushSummaryResult> {
  const result: QuietPushSummaryResult = {
    skipped: null,
    sent: [],
    unreachable: [],
    empty: [],
    failed: [],
  };
  if (env.PUSH_PROVIDER === 'off') return { ...result, skipped: 'push_off' };

  for (const zone of BRAZIL_TIMEZONES) {
    const due = await notificationsRepository.usersForQuietSummary(zone, hourIn(zone, now));
    for (const user of due) {
      try {
        const held = await notificationsRepository.listHeld(
          user.id,
          user.push_quiet_summary_id ?? 0,
        );
        if (held.length === 0) {
          result.empty.push(user.id);
          continue;
        }
        const untilId = Math.max(...held.map((n) => n.id));
        if (!(await notificationsRepository.claimQuietSummary(user.id, untilId))) continue;
        const window = quietWindowOf(user.push_quiet_start, user.push_quiet_end);
        const first = held[0]!;
        const payload =
          held.length === 1
            ? buildPayload({ ...toNotification(first), notificationId: first.id })
            : quietSummaryPayload(held);
        const r = await pushService.send(user.id, payload, {
          ttlSeconds: pushTtlSeconds(timezoneOf(user.timezone), window, now),
        });
        (r.sent > 0 ? result.sent : r.failed > 0 ? result.failed : result.unreachable).push(
          user.id,
        );
      } catch (err) {
        result.failed.push(user.id);
        logger.error({ userId: user.id, err }, 'falha no resumo do silêncio');
      }
    }
  }
  return result;
}
