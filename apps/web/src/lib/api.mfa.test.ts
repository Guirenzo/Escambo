import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  getRefreshToken,
  getToken,
  isMfaChallenge,
  SESSION_EXPIRED_EVENT,
  setSession,
} from './api';

/**
 * Verificação em duas etapas (RF-090, ADR 66) no cliente HTTP: verbo, caminho e corpo de cada
 * chamada; a ativação troca o par de tokens desta sessão (como a troca de senha); e o 401 do
 * segundo passo do login é resposta (pedido vencido), não token a renovar.
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

function sent(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

beforeEach(() => setSession({ accessToken: 'acesso-velho', refreshToken: 'refresh-velho' }));
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('isMfaChallenge', () => {
  it('distingue o pedido do segundo fator da sessão aberta', () => {
    expect(isMfaChallenge({ mfaRequired: true, mfaToken: 't', expiresInSeconds: 300 })).toBe(true);
    expect(
      isMfaChallenge({
        accessToken: 'a',
        refreshToken: 'r',
        user: { id: 1 } as never,
      }),
    ).toBe(false);
  });
});

describe('chamadas da 2FA: verbo, caminho e corpo', () => {
  const cases: Array<[string, () => Promise<unknown>, string, string, unknown]> = [
    [
      'loginMfa',
      () => api.loginMfa({ mfaToken: 'mfa-1', code: '123456' }),
      'POST',
      '/api/auth/login/mfa',
      { mfaToken: 'mfa-1', code: '123456' },
    ],
    ['mfaStatus', () => api.mfaStatus(), 'GET', '/api/auth/mfa', undefined],
    [
      'mfaSetup',
      () => api.mfaSetup('senha-1'),
      'POST',
      '/api/auth/mfa/setup',
      { password: 'senha-1' },
    ],
    [
      'mfaDisable',
      () => api.mfaDisable({ password: 'senha-1', code: 'AB12-CD34' }),
      'POST',
      '/api/auth/mfa/disable',
      { password: 'senha-1', code: 'AB12-CD34' },
    ],
    [
      'mfaRecoveryCodes',
      () => api.mfaRecoveryCodes({ password: 'senha-1', code: '654321' }),
      'POST',
      '/api/auth/mfa/recovery-codes',
      { password: 'senha-1', code: '654321' },
    ],
    [
      'adminAccountLookup',
      () => api.adminAccountLookup('ana+teste@escambo.test'),
      'GET',
      '/api/admin/users/lookup?email=ana%2Bteste%40escambo.test',
      undefined,
    ],
    [
      'adminResetMfa',
      () => api.adminResetMfa('01J/X', 'Perdeu o celular, confirmado no chamado.'),
      'POST',
      '/api/admin/users/01J%2FX/mfa/reset',
      { reason: 'Perdeu o celular, confirmado no chamado.' },
    ],
  ];

  it.each(cases)('%s', async (_name, call, method, url, body) => {
    const fetchMock = stubFetch(reply(200, {}));
    await call();
    const req = sent(fetchMock);
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.body).toEqual(body);
    expect(req.headers.Authorization).toBe('Bearer acesso-velho');
  });
});

describe('api.mfaEnable', () => {
  it('manda o código e guarda o par novo da sessão (as outras caíram)', async () => {
    const fetchMock = stubFetch(
      reply(200, {
        accessToken: 'acesso-novo',
        refreshToken: 'refresh-novo',
        recoveryCodes: ['AAAA-1111'],
      }),
    );

    await expect(api.mfaEnable('123456')).resolves.toEqual({
      accessToken: 'acesso-novo',
      refreshToken: 'refresh-novo',
      recoveryCodes: ['AAAA-1111'],
    });
    const req = sent(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/auth/mfa/enable');
    expect(req.body).toEqual({ code: '123456' });
    expect(getToken()).toBe('acesso-novo');
    expect(getRefreshToken()).toBe('refresh-novo');
  });

  it('código errado: o erro chega à tela e a sessão continua a mesma', async () => {
    stubFetch(reply(400, { error: 'invalid_mfa_code', message: 'Código inválido.' }));

    await expect(api.mfaEnable('000000')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_mfa_code',
      message: 'Código inválido.',
    });
    expect(getToken()).toBe('acesso-velho');
    expect(getRefreshToken()).toBe('refresh-velho');
  });
});

describe('api.loginMfa: o 401 é o pedido vencido, não token a renovar', () => {
  it('não tenta renovar a sessão nem a encerra', async () => {
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    const fetchMock = stubFetch(
      reply(401, { error: 'invalid_mfa_token', message: 'O pedido do código venceu.' }),
    );

    await expect(api.loginMfa({ mfaToken: 'velho', code: '123456' })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_mfa_token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('refresh-velho');
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  });
});
