import { logger } from '../config/logger';
import { notificationsService } from '../modules/notifications/notifications.service';
import { supportRepository } from '../modules/support/support.repository';

/** SLA em horas corridas e encerramento cinco dias após a resolução (RN-061/065). */
export async function runSupportMaintenance(): Promise<{
  alerted: number[];
  closed: number[];
  failed: number[];
}> {
  const result = { alerted: [] as number[], closed: [] as number[], failed: [] as number[] };
  const ids = await supportRepository.maintenanceCandidates(100);
  const admins = await supportRepository.activeAdmins();
  for (const id of ids) {
    try {
      const outcome = await supportRepository.maintain(id, admins);
      if (outcome.alerted) result.alerted.push(id);
      if (outcome.closed) result.closed.push(id);
      for (const saved of outcome.notices) {
        try {
          notificationsService.dispatch(saved);
        } catch {
          logger.warn({ ticketId: id }, 'suporte: entrega opcional do alerta indisponível');
        }
      }
    } catch {
      result.failed.push(id);
      logger.warn({ ticketId: id }, 'suporte: manutenção não confirmada; tentar na próxima rodada');
    }
  }
  return result;
}
