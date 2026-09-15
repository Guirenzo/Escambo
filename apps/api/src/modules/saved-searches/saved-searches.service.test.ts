import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./saved-searches.repository', () => ({
  savedSearchesRepository: {
    create: vi.fn(),
    countForUser: vi.fn(),
    findForUser: vi.fn(),
    listForUser: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

import { savedSearchesRepository, type SavedSearchRow } from './saved-searches.repository';
import { searchLabel, savedSearchesService } from './saved-searches.service';

const repo = vi.mocked(savedSearchesRepository);

const row = (o: Partial<Record<string, unknown>> = {}): SavedSearchRow =>
  ({
    id: 3,
    user_id: 1,
    name: 'Devs em SC',
    query: 'react',
    filters: '{"categoryId":10,"isRemote":true}',
    alert_enabled: 1,
    alert_frequency: 'hourly',
    last_alert_at: new Date('2026-09-15T10:00:00Z'),
    created_at: new Date('2026-09-15T10:00:00Z'),
    ...o,
  }) as unknown as SavedSearchRow;

beforeEach(() => {
  vi.clearAllMocks();
  repo.countForUser.mockResolvedValue(0);
  repo.create.mockResolvedValue(3);
  repo.findForUser.mockResolvedValue(row());
});

describe('savedSearchesService (ADR 35 e 37)', () => {
  it('create limpa texto e nome, serializa os filtros, grava a frequência e devolve a linha', async () => {
    repo.findForUser.mockResolvedValue(row({ alert_frequency: 'daily' }));
    const s = await savedSearchesService.create(1, {
      name: ' Devs em SC ',
      query: ' react ',
      filters: { categoryId: 10, isRemote: true },
      alertEnabled: true,
      alertFrequency: 'daily',
    });
    expect(repo.create).toHaveBeenCalledWith({
      userId: 1,
      name: 'Devs em SC',
      query: 'react',
      filters: JSON.stringify({ categoryId: 10, isRemote: true }),
      alertEnabled: true,
      alertFrequency: 'daily',
    });
    expect(s).toMatchObject({
      id: 3,
      alertEnabled: true,
      alertFrequency: 'daily',
      filters: { categoryId: 10, isRemote: true },
      lastAlertAt: '2026-09-15T10:00:00.000Z',
    });
  });

  it('filtros vazios viram null; o alerta começa desligado e de hora em hora', async () => {
    await savedSearchesService.create(1, { query: 'logo', filters: {} });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: null,
        alertEnabled: false,
        alertFrequency: 'hourly',
        name: null,
      }),
    );
  });

  it('no limite de 20, create é 409 e nada é gravado', async () => {
    repo.countForUser.mockResolvedValue(20);
    await expect(savedSearchesService.create(1, { query: 'x' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'saved_search_limit',
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('list lê filtros em string ou objeto; JSON quebrado vira null', async () => {
    repo.listForUser.mockResolvedValue([
      row({ id: 1, filters: '{"maxPrice":500}', alert_enabled: 0, last_alert_at: null }),
      row({ id: 2, filters: { day: 6 }, alert_frequency: 'instant' }),
      row({ id: 3, filters: '{quebrado' }),
    ]);
    const list = await savedSearchesService.list(1);
    expect(list.map((s) => s.filters)).toEqual([{ maxPrice: 500 }, { day: 6 }, null]);
    expect(list[0]).toMatchObject({
      alertEnabled: false,
      alertFrequency: 'hourly',
      lastAlertAt: null,
    });
    expect(list[1]!.alertFrequency).toBe('instant');
  });

  it('update: 404 para quem não é dono; senão altera e devolve a versão nova', async () => {
    repo.findForUser.mockResolvedValueOnce(undefined);
    await expect(savedSearchesService.update(3, 9, { alertEnabled: false })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(repo.update).not.toHaveBeenCalled();

    repo.findForUser.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ alert_enabled: 0 }));
    const s = await savedSearchesService.update(3, 1, { alertEnabled: false });
    expect(repo.update).toHaveBeenCalledWith(3, 1, { alertEnabled: false });
    expect(s.alertEnabled).toBe(false);
  });

  it('update repassa o nome apagado e a frequência nova', async () => {
    repo.findForUser
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ name: null, alert_frequency: 'instant' }));
    const s = await savedSearchesService.update(3, 1, { name: null, alertFrequency: 'instant' });
    expect(repo.update).toHaveBeenCalledWith(3, 1, { name: null, alertFrequency: 'instant' });
    expect(s).toMatchObject({ name: null, query: 'react', alertFrequency: 'instant' });
  });

  it('remove lança 404 quando não é do usuário', async () => {
    repo.remove.mockResolvedValue(false);
    await expect(savedSearchesService.remove(1, 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('searchLabel: nome, senão texto, senão genérico', () => {
    expect(searchLabel({ name: 'Logo barato', query: 'logo' })).toBe('Logo barato');
    expect(searchLabel({ name: '  ', query: 'logo' })).toBe('logo');
    expect(searchLabel({ name: null, query: null })).toBe('sua busca salva');
  });
});
