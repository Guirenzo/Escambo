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
import { parseFilters, searchLabel, savedSearchesService } from './saved-searches.service';

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

describe('savedSearchesService: dono, limite e formato (ADR 35)', () => {
  it('a 20ª busca ainda entra: o limite conta as buscas do próprio usuário', async () => {
    repo.countForUser.mockResolvedValue(19);

    await savedSearchesService.create(7, { query: 'logo' });

    expect(repo.countForUser).toHaveBeenCalledWith(7);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('no limite, a recusa diz quantas cabem e nada é lido de volta', async () => {
    repo.countForUser.mockResolvedValue(20);

    await expect(savedSearchesService.create(7, { query: 'logo' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'saved_search_limit',
      message: 'Você já tem 20 buscas salvas; apague uma para salvar outra',
    });
    expect(repo.findForUser).not.toHaveBeenCalled();
  });

  it('create devolve a busca recém-gravada, lida pelo id novo e pelo dono', async () => {
    repo.create.mockResolvedValue(31);
    repo.findForUser.mockResolvedValue(
      row({ id: 31, user_id: 7, created_at: new Date('2026-09-20T08:30:00Z') }),
    );

    const s = await savedSearchesService.create(7, { query: 'react' });

    expect(repo.findForUser).toHaveBeenCalledTimes(1);
    expect(repo.findForUser).toHaveBeenCalledWith(31, 7);
    expect(s).toEqual({
      id: 31,
      name: 'Devs em SC',
      query: 'react',
      filters: { categoryId: 10, isRemote: true },
      alertEnabled: true,
      alertFrequency: 'hourly',
      lastAlertAt: '2026-09-15T10:00:00.000Z',
      createdAt: '2026-09-20T08:30:00.000Z',
    });
  });

  it('busca só com filtros grava o texto como null; nome e texto só de espaços também viram null', async () => {
    await savedSearchesService.create(7, { filters: { isRemote: true } });
    await savedSearchesService.create(7, { name: '   ', query: '  ', filters: { day: 6 } });

    expect(repo.create).toHaveBeenNthCalledWith(1, {
      userId: 7,
      name: null,
      query: null,
      filters: '{"isRemote":true}',
      alertEnabled: false,
      alertFrequency: 'hourly',
    });
    expect(repo.create).toHaveBeenNthCalledWith(2, {
      userId: 7,
      name: null,
      query: null,
      filters: '{"day":6}',
      alertEnabled: false,
      alertFrequency: 'hourly',
    });
  });

  it('list traz só as buscas do usuário pedido, na ordem do banco, e lista vazia continua lista', async () => {
    repo.listForUser
      .mockResolvedValueOnce([row({ id: 9 }), row({ id: 3 })])
      .mockResolvedValueOnce([]);

    expect((await savedSearchesService.list(7)).map((s) => s.id)).toEqual([9, 3]);
    expect(await savedSearchesService.list(8)).toEqual([]);

    expect(repo.listForUser).toHaveBeenNthCalledWith(1, 7);
    expect(repo.listForUser).toHaveBeenNthCalledWith(2, 8);
  });

  it('filtros que não são um objeto (lista, número, NULL) viram null', () => {
    expect(parseFilters([1, 2])).toBeNull();
    expect(parseFilters('[1,2]')).toBeNull();
    expect(parseFilters('5')).toBeNull();
    expect(parseFilters(null)).toBeNull();
    expect(parseFilters(undefined)).toBeNull();
    expect(parseFilters({ minRating: 4 })).toEqual({ minRating: 4 });
  });

  it('update confere o dono antes de gravar e relê a busca do mesmo dono depois', async () => {
    repo.findForUser.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ name: 'Novo nome' }));

    const s = await savedSearchesService.update(3, 7, { name: 'Novo nome' });

    expect(s.name).toBe('Novo nome');
    expect(repo.findForUser).toHaveBeenCalledTimes(2);
    expect(repo.findForUser).toHaveBeenNthCalledWith(1, 3, 7);
    expect(repo.findForUser).toHaveBeenNthCalledWith(2, 3, 7);
    expect(repo.update).toHaveBeenCalledWith(3, 7, { name: 'Novo nome' });
    // A gravação fica entre as duas leituras: a resposta é o que ficou no banco.
    const [checked, reread] = repo.findForUser.mock.invocationCallOrder;
    const written = repo.update.mock.invocationCallOrder[0]!;
    expect(checked!).toBeLessThan(written);
    expect(written).toBeLessThan(reread!);
  });

  it('update de busca que não é do usuário é 404 saved_search_not_found', async () => {
    repo.findForUser.mockResolvedValue(undefined);

    await expect(savedSearchesService.update(3, 9, { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'saved_search_not_found',
      message: 'Busca salva não encontrada',
    });
    expect(repo.findForUser).toHaveBeenCalledWith(3, 9);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('remove apaga a busca do id pedido em nome do dono; se nada foi apagado, é 404', async () => {
    repo.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await savedSearchesService.remove(3, 7)).toBeUndefined();
    expect(repo.remove).toHaveBeenCalledWith(3, 7);

    await expect(savedSearchesService.remove(3, 9)).rejects.toMatchObject({
      statusCode: 404,
      code: 'saved_search_not_found',
      message: 'Busca salva não encontrada',
    });
    expect(repo.remove).toHaveBeenLastCalledWith(3, 9);
  });
});
