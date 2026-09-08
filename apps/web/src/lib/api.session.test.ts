import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getRefreshToken, getToken, SESSION_EXPIRED_EVENT, setSession } from './api';

/** Resposta fake do fetch. */
const reply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('sessão: renovação silenciosa do access token', () => {
  beforeEach(() => setSession({ accessToken: 'velho', refreshToken: 'refresh-1' }));
  afterEach(() => {
    vi.restoreAllMocks();
    setSession(null);
  });

  it('num 401 renova com o refresh token e repete a chamada uma vez', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(401, { error: 'unauthorized' })) // /auth/me com token vencido
      .mockResolvedValueOnce(reply(200, { accessToken: 'novo', refreshToken: 'refresh-2' })) // refresh
      .mockResolvedValueOnce(reply(200, { id: 1, ulid: 'u1', email: 'a@b.com', role: 'client' })); // retry
    vi.stubGlobal('fetch', fetchMock);

    const me = await api.me();

    expect(me.email).toBe('a@b.com');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/refresh');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      refreshToken: 'refresh-1',
    });
    // retry já vai com o token novo; o par de tokens foi rotacionado
    expect(fetchMock.mock.calls[2]?.[1]?.headers?.Authorization).toBe('Bearer novo');
    expect(getToken()).toBe('novo');
    expect(getRefreshToken()).toBe('refresh-2');
  });

  it('se a renovação falha, encerra a sessão e avisa a aplicação', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(401))
      .mockResolvedValueOnce(reply(401, { error: 'refresh_invalid' }));
    vi.stubGlobal('fetch', fetchMock);
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);

    await expect(api.me()).rejects.toThrow();

    expect(expired).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  });

  it('várias chamadas com 401 ao mesmo tempo compartilham uma única renovação', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/refresh') {
        return Promise.resolve(reply(200, { accessToken: 'novo', refreshToken: 'refresh-2' }));
      }
      // primeira tentativa (token velho) → 401; retry (token novo) → 200
      return Promise.resolve(
        fetchMock.mock.calls.filter(([u]) => u === url).length === 1 ? reply(401) : reply(200, []),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([api.categories(), api.contracts(), api.notifications()]);

    const refreshCalls = fetchMock.mock.calls.filter(([u]) => u === '/api/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
  });

  it('401 no login não tenta renovar (credenciais erradas são erro normal)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(401, { message: 'Credenciais inválidas' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.login({ email: 'a@b.com', password: 'x' })).rejects.toThrow(
      'Credenciais inválidas',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
