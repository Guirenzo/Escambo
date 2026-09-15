import type { SavedSearch, SavedSearchFilters } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { savedSearchesRepository, type SavedSearchRow } from './saved-searches.repository';
import {
  SAVED_SEARCHES_MAX,
  type CreateSavedSearchInput,
  type UpdateSavedSearchInput,
} from './saved-searches.schema';

/** JSON da coluna (objeto, string ou NULL) → filtros; JSON quebrado ou não-objeto vira null. */
export function parseFilters(v: unknown): SavedSearchFilters | null {
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as SavedSearchFilters) : null;
}

export function toSavedSearch(r: SavedSearchRow): SavedSearch {
  return {
    id: r.id,
    name: r.name,
    query: r.query,
    filters: parseFilters(r.filters),
    alertEnabled: Boolean(r.alert_enabled),
    alertFrequency: r.alert_frequency,
    lastAlertAt: r.last_alert_at ? new Date(r.last_alert_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Como a busca aparece para a pessoa: o nome dado, o texto buscado ou um genérico. */
export const searchLabel = (s: { name: string | null; query: string | null }): string =>
  s.name?.trim() || s.query?.trim() || 'sua busca salva';

export const savedSearchesService = {
  async create(userId: number, input: CreateSavedSearchInput): Promise<SavedSearch> {
    if ((await savedSearchesRepository.countForUser(userId)) >= SAVED_SEARCHES_MAX) {
      throw new HttpError(
        409,
        `Você já tem ${SAVED_SEARCHES_MAX} buscas salvas; apague uma para salvar outra`,
        'saved_search_limit',
      );
    }
    const filters = input.filters && Object.keys(input.filters).length > 0 ? input.filters : null;
    const id = await savedSearchesRepository.create({
      userId,
      name: input.name?.trim() || null,
      query: input.query?.trim() || null,
      filters: filters ? JSON.stringify(filters) : null,
      alertEnabled: input.alertEnabled ?? false,
      alertFrequency: input.alertFrequency ?? 'hourly',
    });
    return toSavedSearch((await savedSearchesRepository.findForUser(id, userId))!);
  },

  async list(userId: number): Promise<SavedSearch[]> {
    return (await savedSearchesRepository.listForUser(userId)).map(toSavedSearch);
  },

  async update(id: number, userId: number, input: UpdateSavedSearchInput): Promise<SavedSearch> {
    if (!(await savedSearchesRepository.findForUser(id, userId))) {
      throw new HttpError(404, 'Busca salva não encontrada', 'saved_search_not_found');
    }
    await savedSearchesRepository.update(id, userId, input);
    return toSavedSearch((await savedSearchesRepository.findForUser(id, userId))!);
  },

  async remove(id: number, userId: number): Promise<void> {
    const ok = await savedSearchesRepository.remove(id, userId);
    if (!ok) throw new HttpError(404, 'Busca salva não encontrada', 'saved_search_not_found');
  },
};
