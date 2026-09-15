import type { SavedSearchFilters } from '@escambo/types';
import { logger } from '../config/logger';
import { notificationsService } from '../modules/notifications/notifications.service';
import { savedSearchesRepository } from '../modules/saved-searches/saved-searches.repository';
import { parseFilters, searchLabel } from '../modules/saved-searches/saved-searches.service';
import {
  servicesRepository,
  type ServiceListFilters,
} from '../modules/services/services.repository';

/**
 * Alertas de busca salva (ADR 35). Cada busca com alerta tem um cursor (last_alert_at): quando
 * ele passa de ALERT_EVERY_MINUTES, o job procura serviços criados em [cursor, agora) que casam
 * com o texto e os filtros — fora os do próprio dono — e manda uma notificação com até
 * MATCHES_SHOWN títulos. O cursor avança mesmo sem resultado. Janela fechada à esquerda e aberta
 * à direita, no segundo cheio (DATETIME não tem milissegundo): um serviço criado no segundo do
 * fim da janela entra na próxima, nunca em duas nem em nenhuma.
 */

export const ALERT_EVERY_MINUTES = 60;
export const MAX_SEARCHES_PER_RUN = 200;
export const MATCHES_SHOWN = 5;

export interface SavedSearchAlertsResult {
  checked: number;
  alerted: number[];
  failed: number[];
}

/** Filtros salvos → filtros do repositório de serviços, sem chaves vazias (período só com dia). */
export function toListFilters(
  f: SavedSearchFilters | null,
): Omit<ServiceListFilters, 'limit' | 'offset'> {
  if (!f) return {};
  const mapped: Omit<ServiceListFilters, 'limit' | 'offset'> = {
    categoryId: f.categoryId,
    isRemote: f.isRemote,
    lat: f.lat,
    lng: f.lng,
    radiusKm: f.radiusKm,
    minPrice: f.minPrice,
    maxPrice: f.maxPrice,
    maxDeliveryDays: f.maxDeliveryDays,
    minRating: f.minRating,
    day: f.day,
    period: f.day !== undefined ? f.period : undefined,
  };
  return Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined)) as Omit<
    ServiceListFilters,
    'limit' | 'offset'
  >;
}

/** "Serviço novo para “logo”", "3 serviços novos para “logo”", "Mais de 5 serviços novos…". */
export function alertTitle(count: number, label: string, more: boolean): string {
  if (more) return `Mais de ${MATCHES_SHOWN} serviços novos para “${label}”`;
  return count === 1 ? `Serviço novo para “${label}”` : `${count} serviços novos para “${label}”`;
}

export async function runSavedSearchAlerts(
  now: Date = new Date(),
): Promise<SavedSearchAlertsResult> {
  const until = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const dueBefore = new Date(until.getTime() - ALERT_EVERY_MINUTES * 60_000);
  const due = await savedSearchesRepository.dueForAlert(dueBefore, MAX_SEARCHES_PER_RUN);
  const result: SavedSearchAlertsResult = { checked: due.length, alerted: [], failed: [] };

  for (const s of due) {
    try {
      const rows = await servicesRepository.list({
        ...toListFilters(parseFilters(s.filters)),
        q: s.query?.trim() || undefined,
        createdFrom: s.last_alert_at ?? s.created_at,
        createdBefore: until,
        excludeOwnerId: s.user_id,
        sort: 'newest',
        limit: MATCHES_SHOWN + 1,
        offset: 0,
      });
      if (rows.length > 0) {
        const shown = rows.slice(0, MATCHES_SHOWN);
        // Best-effort (nunca lança): uma falha ao gravar a notificação não segura o cursor.
        await notificationsService.notify(s.user_id, {
          type: 'saved_search_match',
          title: alertTitle(shown.length, searchLabel(s), rows.length > MATCHES_SHOWN),
          body: shown
            .slice(0, 3)
            .map((r) => r.title)
            .join(' · '),
          data: { savedSearchId: s.id, serviceIds: shown.map((r) => r.id) },
        });
        result.alerted.push(s.id);
      }
      await savedSearchesRepository.advanceCursor(s.id, until);
    } catch (err) {
      result.failed.push(s.id);
      logger.error({ err, savedSearchId: s.id }, 'alerta de busca salva falhou');
    }
  }
  return result;
}
