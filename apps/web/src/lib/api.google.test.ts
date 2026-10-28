import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  getRefreshToken,
  GOOGLE_START_URL,
  isGoogleSignup,
  isMfaChallenge,
  SESSION_EXPIRED_EVENT,
  setSession,
} from './api';

/**
 * Login com Google (RF-002) no cliente HTTP: o botão é um link para a API (nada do Google roda no
 * app), as três chamadas novas com verbo, caminho e corpo, e o 401 da troca e do cadastro é
 * resposta, não token a renovar.
 */

const reply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function stubFetch(...responses: unknown[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => setSession({ accessToken: 'acesso-velho', refreshToken: 'refresh-velho' }));
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('login com Google no cliente HTTP', () => {
  it('o botão leva à API, no mesmo endereço do app', () => {
    expect(GOOGLE_START_URL).toBe('/api/auth/google/start');
  });

  it('providers, exchange e signup: verbo, caminho e corpo', async () => {
    const fetchMock = stubFetch(
      reply(200, { google: true }),
      reply(200, { mfaRequired: true, mfaToken: 't', expiresInSeconds: 300 }),
      reply(201, { accessToken: 'a', refreshToken: 'r', user: { id: 1 } }),
    );
    expect(await api.authProviders()).toEqual({ google: true });
    await api.googleExchange('codigo-1');
    await api.googleSignup({ signupToken: 's', role: 'client', legalAccepted: true });

    const calls = fetchMock.mock.calls as [string, RequestInit | undefined][];
    expect(calls.map(([url, init]) => [url, init?.method ?? 'GET', init?.body])).toEqual([
      ['/api/auth/providers', 'GET', undefined],
      ['/api/auth/google/exchange', 'POST', JSON.stringify({ code: 'codigo-1' })],
      [
        '/api/auth/google/signup',
        'POST',
        JSON.stringify({ signupToken: 's', role: 'client', legalAccepted: true }),
      ],
    ]);
  });

  it('o 401 da troca e do cadastro não tenta renovar nem encerra a sessão guardada', async () => {
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    const fetchMock = stubFetch(
      reply(401, { error: 'invalid_google_code', message: 'Expirou.' }),
      reply(401, { error: 'invalid_signup_token', message: 'Expirou.' }),
    );
    await expect(api.googleExchange('x')).rejects.toMatchObject({ status: 401 });
    await expect(
      api.googleSignup({ signupToken: 's', role: 'client', legalAccepted: true }),
    ).rejects.toMatchObject({ code: 'invalid_signup_token' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(expired).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('refresh-velho');
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  });

  it('isGoogleSignup e isMfaChallenge separam as três respostas da troca', () => {
    const signup = {
      signupRequired: true as const,
      signupToken: 's',
      expiresInSeconds: 900,
      email: 'a@gmail.com',
      name: null,
    };
    const mfa = { mfaRequired: true as const, mfaToken: 't', expiresInSeconds: 300 };
    const session = { accessToken: 'a', refreshToken: 'r', user: { id: 1 } as never };
    expect([signup, mfa, session].map((r) => [isGoogleSignup(r), isMfaChallenge(r)])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });
});
