import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getRefreshToken, getToken, setSession } from './api';

/**
 * Troca de senha com login (RF-017): a chamada sai com a senha atual e a nova, e o par novo que a
 * API devolve substitui o desta sessão (o refresh antigo foi revogado junto com as outras).
 */

const reply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => setSession({ accessToken: 'acesso-velho', refreshToken: 'refresh-velho' }));
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('api.changePassword', () => {
  it('manda POST /api/auth/change-password com a senha atual e a nova, com o token da sessão', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply(200, { accessToken: 'acesso-novo', refreshToken: 'refresh-novo' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.changePassword({ currentPassword: 'senha-antiga', newPassword: 'senha-nova-123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/change-password');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      currentPassword: 'senha-antiga',
      newPassword: 'senha-nova-123',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer acesso-velho');
  });

  it('guarda o par novo da sessão e o devolve', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          reply(200, { accessToken: 'acesso-novo', refreshToken: 'refresh-novo' }),
        ),
    );

    await expect(
      api.changePassword({ currentPassword: 'senha-antiga', newPassword: 'senha-nova-123' }),
    ).resolves.toEqual({ accessToken: 'acesso-novo', refreshToken: 'refresh-novo' });
    expect(getToken()).toBe('acesso-novo');
    expect(getRefreshToken()).toBe('refresh-novo');
  });

  it('senha atual errada: o erro chega à tela e a sessão continua a mesma', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          reply(400, { error: 'wrong_password', message: 'Senha atual incorreta' }),
        ),
    );

    await expect(
      api.changePassword({ currentPassword: 'errada', newPassword: 'senha-nova-123' }),
    ).rejects.toMatchObject({
      message: 'Senha atual incorreta',
      status: 400,
      code: 'wrong_password',
    });
    expect(getToken()).toBe('acesso-velho');
    expect(getRefreshToken()).toBe('refresh-velho');
  });
});
