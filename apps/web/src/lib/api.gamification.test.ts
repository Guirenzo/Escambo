import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setSession } from './api';

/**
 * Missões e ranking filtrado (RF-066, RF-067): o caminho de cada chamada e só os filtros
 * preenchidos na URL. O raio do ranking local não sai daqui: é parâmetro da plataforma.
 */

function stubFetch(body: unknown = []) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urlOf = (fetchMock: ReturnType<typeof vi.fn>): string =>
  (fetchMock.mock.calls[0] as [string])[0];

afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('gamificação: missões e ranking', () => {
  it('missions lê as missões de quem está logado', async () => {
    const fetchMock = stubFetch([{ id: 1 }]);
    expect(await api.missions()).toEqual([{ id: 1 }]);
    expect(urlOf(fetchMock)).toBe('/api/gamification/me/missions');
  });

  it('leaderboard sem filtro não põe "?" no caminho', async () => {
    const fetchMock = stubFetch();
    await api.leaderboard({});
    expect(urlOf(fetchMock)).toBe('/api/gamification/leaderboard');
  });

  it('leaderboard manda a categoria e o ponto do "perto de mim"', async () => {
    const fetchMock = stubFetch();
    await api.leaderboard({ categoryId: 10, lat: -26.3044, lng: -48.8487 });
    expect(urlOf(fetchMock)).toBe(
      '/api/gamification/leaderboard?categoryId=10&lat=-26.3044&lng=-48.8487',
    );
  });

  it('lat sem lng não vai: o ponto só existe completo', async () => {
    const fetchMock = stubFetch();
    await api.leaderboard({ lat: -26.3 });
    expect(urlOf(fetchMock)).toBe('/api/gamification/leaderboard');
  });
});
