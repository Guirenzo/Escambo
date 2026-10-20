import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getRefreshToken, getToken, setSession } from './api';

/**
 * Contato da conta (RF-017): as chamadas da troca de e-mail e do telefone, e a confirmação que,
 * vindo a sessão nova desta aba, troca o par guardado (o antigo caiu junto com as outras sessões).
 */

const reply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const CONTACT = {
  email: 'ana@escambo.test',
  emailVerified: true,
  phone: '+5547999991234',
  pendingEmail: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
const sent = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    body: init.body ? JSON.parse(init.body as string) : undefined,
    auth: (init.headers as Record<string, string>).Authorization,
  };
};

beforeEach(() => {
  setSession({ accessToken: 'acesso-velho', refreshToken: 'refresh-velho' });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('api: contato da conta', () => {
  it('accountContact lê GET /api/auth/contact com o token da sessão', async () => {
    fetchMock.mockResolvedValue(reply(200, CONTACT));
    await expect(api.accountContact()).resolves.toEqual(CONTACT);
    expect(sent()).toEqual({
      url: '/api/auth/contact',
      method: 'GET',
      body: undefined,
      auth: 'Bearer acesso-velho',
    });
  });

  it('changeEmail manda a senha atual e o e-mail novo, e devolve o pedido pendente', async () => {
    const pending = { email: 'nova@escambo.test', expiresAt: '2026-10-20T12:00:00.000Z' };
    fetchMock.mockResolvedValue(reply(202, pending));
    await expect(
      api.changeEmail({ currentPassword: 'senha', newEmail: 'nova@escambo.test' }),
    ).resolves.toEqual(pending);
    expect(sent()).toMatchObject({
      url: '/api/auth/change-email',
      method: 'POST',
      body: { currentPassword: 'senha', newEmail: 'nova@escambo.test' },
    });
  });

  it('cancelEmailChange é DELETE /api/auth/change-email (204)', async () => {
    fetchMock.mockResolvedValue(reply(204));
    await expect(api.cancelEmailChange()).resolves.toBeUndefined();
    expect(sent()).toMatchObject({ url: '/api/auth/change-email', method: 'DELETE' });
  });

  it('updatePhone manda o telefone como digitado (ou null) em PUT /api/auth/phone', async () => {
    fetchMock.mockResolvedValue(reply(200, CONTACT));
    await api.updatePhone('(47) 99999-1234');
    await api.updatePhone(null);
    expect(sent(0)).toMatchObject({
      url: '/api/auth/phone',
      method: 'PUT',
      body: { phone: '(47) 99999-1234' },
    });
    expect(sent(1).body).toEqual({ phone: null });
  });

  describe('confirmEmailChange', () => {
    it('com a sessão nova desta aba, guarda o par novo', async () => {
      fetchMock.mockResolvedValue(
        reply(200, {
          email: 'nova@escambo.test',
          session: { accessToken: 'acesso-novo', refreshToken: 'refresh-novo' },
        }),
      );
      const res = await api.confirmEmailChange('t'.repeat(32));
      expect(res.email).toBe('nova@escambo.test');
      expect(sent()).toEqual({
        url: '/api/auth/confirm-email-change',
        method: 'POST',
        body: { token: 't'.repeat(32) },
        auth: 'Bearer acesso-velho',
      });
      expect(getToken()).toBe('acesso-novo');
      expect(getRefreshToken()).toBe('refresh-novo');
    });

    it('sem sessão nova (aba de outra conta ou sem login), não mexe na sessão guardada', async () => {
      fetchMock.mockResolvedValue(reply(200, { email: 'nova@escambo.test', session: null }));
      await api.confirmEmailChange('t'.repeat(32));
      expect(getToken()).toBe('acesso-velho');
      expect(getRefreshToken()).toBe('refresh-velho');
    });

    it('link vencido: o erro chega à tela', async () => {
      fetchMock.mockResolvedValue(
        reply(400, { error: 'invalid_token', message: 'Link inválido ou vencido' }),
      );
      await expect(api.confirmEmailChange('t'.repeat(32))).rejects.toMatchObject({
        message: 'Link inválido ou vencido',
        code: 'invalid_token',
      });
      expect(getToken()).toBe('acesso-velho');
    });
  });
});
