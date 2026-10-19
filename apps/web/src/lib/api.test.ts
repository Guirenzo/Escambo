import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, setToken } from './api';

interface FetchCall {
  headers: Record<string, string>;
}

describe('api client', () => {
  beforeEach(() => setToken(null));
  afterEach(() => vi.restoreAllMocks());

  it('inclui o Bearer token e faz parse do JSON de sucesso', async () => {
    setToken('tok-123');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, ulid: 'u1', email: 'a@b.com', role: 'client' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const me = await api.me();

    expect(me.email).toBe('a@b.com');
    const [url, opts] = fetchMock.mock.calls[0] as [string, FetchCall];
    expect(url).toBe('/api/auth/me');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
  });

  it('omite o Authorization quando não há token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.categories();

    const [, opts] = fetchMock.mock.calls[0] as [string, FetchCall];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('trata 204 No Content como undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) }),
    );
    await expect(api.markNotificationRead(5)).resolves.toBeUndefined();
  });

  it('lança com a mensagem do backend quando a resposta é erro', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: 'Deu ruim' }) }),
    );
    await expect(api.wallet()).rejects.toThrow('Deu ruim');
  });

  it('preserva o conflito e a contratação existente sem copiar outros dados da resposta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: 'active_contract_exists',
          message: 'Acompanhe a contratação existente antes de enviar outra.',
          contractId: 73,
          details: { internal: 'não expor' },
        }),
      }),
    );

    const failure = await api.wallet().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: 'Acompanhe a contratação existente antes de enviar outra.',
      status: 409,
      code: 'active_contract_exists',
      contractId: 73,
    });
    expect(failure).not.toHaveProperty('details');
  });

  it.each([undefined, null, '73', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'não aceita identificador inválido de contratação: %s',
    async (contractId) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ error: 'active_contract_exists', contractId }),
        }),
      );

      await expect(api.wallet()).rejects.toMatchObject({
        message: 'active_contract_exists',
        status: 409,
        contractId: undefined,
      });
    },
  );

  it('mantém a mensagem genérica quando a falha não traz JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('Resposta sem JSON');
        },
      }),
    );

    await expect(api.wallet()).rejects.toThrow('Erro 502');
  });
});
