import type { SavedSearchAlertFrequency, SavedSearchFilters } from '@escambo/types';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { notificationsService } from '../modules/notifications/notifications.service';
import {
  savedSearchesRepository,
  type AlertDueThresholds,
} from '../modules/saved-searches/saved-searches.repository';
import { parseFilters, searchLabel } from '../modules/saved-searches/saved-searches.service';
import {
  servicesRepository,
  type ServiceListFilters,
} from '../modules/services/services.repository';
import { hourInBrt, startOfTodayBrt } from './daily-digest';

/**
 * Alertas de busca salva (ADR 35 e 37). Cada busca com alerta tem um cursor (last_alert_at) e uma
 * frequência. "Na hora" confere a toda rodada dos jobs; "de hora em hora" espera o cursor passar
 * de ALERT_EVERY_MINUTES; "uma vez por dia" espera o cursor ficar antes do último horário do dono (ADR 42) em
 * Brasília, o mesmo horário do resumo diário de e-mail. Vencida, a busca procura serviços criados
 * em [cursor, agora) que casam com o texto e os filtros — fora os do próprio dono — e manda uma
 * notificação com até MATCHES_SHOWN títulos. O cursor avança mesmo sem resultado. Janela fechada
 * à esquerda e aberta à direita, no segundo cheio (DATETIME não tem milissegundo): um serviço
 * criado no segundo do fim da janela entra na próxima, nunca em duas nem em nenhuma. Trocar a
 * frequência não mexe no cursor, então não abre buraco nem repete aviso.
 */

export const ALERT_EVERY_MINUTES = 60;
export const MAX_SEARCHES_PER_RUN = 200;
export const MATCHES_SHOWN = 5;

const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SavedSearchAlertsResult {
  checked: number;
  alerted: number[];
  failed: number[];
}

/** Último horário do alerta diário até `now`: `hour` de hoje em Brasília se já passou, senão o de ontem. */
export function lastDailyAlertAt(now: Date, hour: number = env.DIGEST_HOUR): Date {
  const today = new Date(startOfTodayBrt(now).getTime() + hour * HOUR);
  return today.getTime() <= now.getTime() ? today : new Date(today.getTime() - DAY);
}

/**
 * Limite do cursor de cada frequência para entrar na rodada que fecha em `until`. Os cursores são
 * segundos cheios, então "até um segundo antes" é o mesmo que "antes de": na hora, qualquer cursor
 * anterior ao fim da janela; por dia, anterior ao último horário diário do dono (ADR 42), que a
 * consulta calcula com a hora dele do mesmo jeito que `lastDailyAlertAt`.
 */
export function alertDueThresholds(
  until: Date,
  defaultHour: number = env.DIGEST_HOUR,
): AlertDueThresholds {
  return {
    instant: new Date(until.getTime() - SECOND),
    hourly: new Date(until.getTime() - ALERT_EVERY_MINUTES * 60_000),
    daily: { dayStart: startOfTodayBrt(until), hourNow: hourInBrt(until), defaultHour },
  };
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

/**
 * "Serviço novo para “logo”", "3 serviços novos para “logo”", "Mais de 5 serviços novos…". O aviso
 * diário cobre um dia inteiro e diz isso no título, para não parecer que tudo chegou agora.
 */
export function alertTitle(
  count: number,
  label: string,
  more: boolean,
  frequency: SavedSearchAlertFrequency = 'hourly',
): string {
  const title = more
    ? `Mais de ${MATCHES_SHOWN} serviços novos para “${label}”`
    : count === 1
      ? `Serviço novo para “${label}”`
      : `${count} serviços novos para “${label}”`;
  return frequency === 'daily'
    ? `Resumo do dia: ${title.charAt(0).toLowerCase()}${title.slice(1)}`
    : title;
}

export async function runSavedSearchAlerts(
  now: Date = new Date(),
): Promise<SavedSearchAlertsResult> {
  const until = new Date(Math.floor(now.getTime() / SECOND) * SECOND);
  const due = await savedSearchesRepository.dueForAlert(
    alertDueThresholds(until),
    MAX_SEARCHES_PER_RUN,
  );
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
          title: alertTitle(
            shown.length,
            searchLabel(s),
            rows.length > MATCHES_SHOWN,
            s.alert_frequency,
          ),
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
