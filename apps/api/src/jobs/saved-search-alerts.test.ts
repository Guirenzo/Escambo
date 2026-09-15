import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/saved-searches/saved-searches.repository', () => ({
  savedSearchesRepository: { dueForAlert: vi.fn(), advanceCursor: vi.fn() },
}));
vi.mock('../modules/services/services.repository', () => ({
  servicesRepository: { list: vi.fn() },
}));
vi.mock('../modules/notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));

import { notificationsService } from '../modules/notifications/notifications.service';
import { savedSearchesRepository } from '../modules/saved-searches/saved-searches.repository';
import { servicesRepository } from '../modules/services/services.repository';
import {
  alertDueThresholds,
  alertTitle,
  lastDailyAlertAt,
  runSavedSearchAlerts,
  toListFilters,
} from './saved-search-alerts';

const repo = vi.mocked(savedSearchesRepository);
const services = vi.mocked(servicesRepository);
const notify = vi.mocked(notificationsService.notify);

// 12:30:45 em Brasília; o horário diário padrão (DIGEST_HOUR = 8) é 11:00Z.
const NOW = new Date('2026-09-15T15:30:45.678Z');
const UNTIL = new Date('2026-09-15T15:30:45.000Z');
const CURSOR = new Date('2026-09-15T13:00:00.000Z');
const CREATED = new Date('2026-09-01T00:00:00.000Z');

const search = (o: Record<string, unknown> = {}) =>
  ({
    id: 7,
    user_id: 42,
    name: null,
    query: 'logo',
    filters: '{"maxPrice":500,"day":1,"period":"morning"}',
    alert_enabled: 1,
    alert_frequency: 'hourly',
    last_alert_at: CURSOR,
    created_at: CREATED,
    ...o,
  }) as never;
const svc = (id: number, title: string) => ({ id, title }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repo.dueForAlert.mockResolvedValue([]);
  repo.advanceCursor.mockResolvedValue(undefined);
  services.list.mockResolvedValue([]);
  notify.mockResolvedValue(undefined);
});

describe('job saved-search-alerts (ADR 35 e 37)', () => {
  it('pede as buscas vencidas de cada frequência e procura em [cursor, agora) no segundo cheio', async () => {
    repo.dueForAlert.mockResolvedValue([search()]);
    services.list.mockResolvedValue([svc(1, 'Logo A'), svc(2, 'Logo B')]);

    const r = await runSavedSearchAlerts(NOW);

    expect(repo.dueForAlert).toHaveBeenCalledWith(
      {
        instant: new Date('2026-09-15T15:30:44.000Z'),
        hourly: new Date('2026-09-15T14:30:45.000Z'),
        daily: new Date('2026-09-15T10:59:59.000Z'),
      },
      200,
    );
    expect(services.list).toHaveBeenCalledWith({
      maxPrice: 500,
      day: 1,
      period: 'morning',
      q: 'logo',
      createdFrom: CURSOR,
      createdBefore: UNTIL,
      excludeOwnerId: 42,
      sort: 'newest',
      limit: 6,
      offset: 0,
    });
    expect(notify).toHaveBeenCalledWith(42, {
      type: 'saved_search_match',
      title: '2 serviços novos para “logo”',
      body: 'Logo A · Logo B',
      data: { savedSearchId: 7, serviceIds: [1, 2] },
    });
    expect(repo.advanceCursor).toHaveBeenCalledWith(7, UNTIL);
    expect(r).toEqual({ checked: 1, alerted: [7], failed: [] });
  });

  it('sem cursor usa a criação da busca; sem resultado não avisa, mas avança o cursor', async () => {
    repo.dueForAlert.mockResolvedValue([search({ last_alert_at: null, filters: null })]);

    const r = await runSavedSearchAlerts(NOW);

    expect(services.list).toHaveBeenCalledWith(expect.objectContaining({ createdFrom: CREATED }));
    expect(notify).not.toHaveBeenCalled();
    expect(repo.advanceCursor).toHaveBeenCalledWith(7, UNTIL);
    expect(r.alerted).toEqual([]);
  });

  it('mais de cinco: título "Mais de 5", mostra cinco e o corpo com três títulos', async () => {
    repo.dueForAlert.mockResolvedValue([search({ name: 'Design' })]);
    services.list.mockResolvedValue(Array.from({ length: 6 }, (_, i) => svc(i + 1, `S${i + 1}`)));

    await runSavedSearchAlerts(NOW);

    expect(notify).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        title: 'Mais de 5 serviços novos para “Design”',
        body: 'S1 · S2 · S3',
        data: { savedSearchId: 7, serviceIds: [1, 2, 3, 4, 5] },
      }),
    );
  });

  it('busca diária avisa com o título de resumo do dia', async () => {
    repo.dueForAlert.mockResolvedValue([search({ alert_frequency: 'daily' })]);
    services.list.mockResolvedValue([svc(1, 'Logo A'), svc(2, 'Logo B')]);

    await runSavedSearchAlerts(NOW);

    expect(notify).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ title: 'Resumo do dia: 2 serviços novos para “logo”' }),
    );
  });

  it('falha numa busca não derruba as outras nem avança o cursor dela', async () => {
    repo.dueForAlert.mockResolvedValue([search({ id: 1 }), search({ id: 2 })]);
    services.list.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce([svc(9, 'X')]);

    const r = await runSavedSearchAlerts(NOW);

    expect(r).toEqual({ checked: 2, alerted: [2], failed: [1] });
    expect(repo.advanceCursor).toHaveBeenCalledTimes(1);
    expect(repo.advanceCursor).toHaveBeenCalledWith(2, UNTIL);
  });

  it('toListFilters descarta chaves vazias e período sem dia; títulos no singular e no resumo', () => {
    expect(toListFilters({ period: 'morning', minPrice: 10 })).toEqual({ minPrice: 10 });
    expect(toListFilters({ lat: -26.3, lng: -48.8, radiusKm: 10 })).toEqual({
      lat: -26.3,
      lng: -48.8,
      radiusKm: 10,
    });
    expect(toListFilters(null)).toEqual({});
    expect(alertTitle(1, 'logo', false)).toBe('Serviço novo para “logo”');
    expect(alertTitle(1, 'logo', false, 'instant')).toBe('Serviço novo para “logo”');
    expect(alertTitle(1, 'logo', false, 'daily')).toBe('Resumo do dia: serviço novo para “logo”');
    expect(alertTitle(9, 'logo', true, 'daily')).toBe(
      'Resumo do dia: mais de 5 serviços novos para “logo”',
    );
  });
});

describe('horário do alerta diário (ADR 37)', () => {
  it('antes do horário de hoje vale o de ontem; no segundo exato já vale o de hoje', () => {
    expect(lastDailyAlertAt(new Date('2026-09-15T10:59:59Z'), 8)).toEqual(
      new Date('2026-09-14T11:00:00.000Z'),
    );
    expect(lastDailyAlertAt(new Date('2026-09-15T11:00:00Z'), 8)).toEqual(
      new Date('2026-09-15T11:00:00.000Z'),
    );
  });

  it('usa o dia de Brasília mesmo quando a data em UTC já virou', () => {
    // 23:30 do dia 14 em Brasília = 02:30Z do dia 15.
    const late = new Date('2026-09-15T02:30:00Z');
    expect(lastDailyAlertAt(late, 0)).toEqual(new Date('2026-09-14T03:00:00.000Z'));
    expect(lastDailyAlertAt(late, 23)).toEqual(new Date('2026-09-15T02:00:00.000Z'));
  });

  it('limites: na hora é qualquer cursor antes do fim; por dia, antes do último horário diário', () => {
    expect(alertDueThresholds(new Date('2026-09-15T10:00:00Z'), 8)).toEqual({
      instant: new Date('2026-09-15T09:59:59.000Z'),
      hourly: new Date('2026-09-15T09:00:00.000Z'),
      daily: new Date('2026-09-14T10:59:59.000Z'),
    });
  });
});
