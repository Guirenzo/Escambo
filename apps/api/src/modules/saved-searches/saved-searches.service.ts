import type { SavedSearch } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { savedSearchesRepository, type SavedSearchRow } from './saved-searches.repository';
import type { CreateSavedSearchInput } from './saved-searches.schema';

function toSavedSearch(r: SavedSearchRow): SavedSearch {
  const filters =
    r.filters == null
      ? null
      : typeof r.filters === 'string'
        ? (JSON.parse(r.filters) as Record<string, unknown>)
        : r.filters;
  return {
    id: r.id,
    name: r.name,
    query: r.query,
    filters,
    alertEnabled: Boolean(r.alert_enabled),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const savedSearchesService = {
  async create(userId: number, input: CreateSavedSearchInput): Promise<SavedSearch> {
    const id = await savedSearchesRepository.create({
      userId,
      name: input.name ?? null,
      query: input.query ?? null,
      filters: input.filters != null ? JSON.stringify(input.filters) : null,
      alertEnabled: input.alertEnabled ?? false,
    });
    return {
      id,
      name: input.name ?? null,
      query: input.query ?? null,
      filters: input.filters ?? null,
      alertEnabled: input.alertEnabled ?? false,
      createdAt: new Date().toISOString(),
    };
  },

  async list(userId: number): Promise<SavedSearch[]> {
    return (await savedSearchesRepository.listForUser(userId)).map(toSavedSearch);
  },

  async remove(id: number, userId: number): Promise<void> {
    const ok = await savedSearchesRepository.remove(id, userId);
    if (!ok) throw new HttpError(404, 'Busca salva não encontrada', 'saved_search_not_found');
  },
};
