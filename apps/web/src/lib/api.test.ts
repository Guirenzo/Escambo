import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiRequestError,
  NETWORK_ERROR_MESSAGE,
  setToken,
  statusMessage,
  UNAVAILABLE_MESSAGE,
} from './api';

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

      // Sem mensagem da API, o código interno não vai para a tela: fica em `code`.
      await expect(api.wallet()).rejects.toMatchObject({
        message: 'Não foi possível concluir. Tente de novo.',
        status: 409,
        code: 'active_contract_exists',
        contractId: undefined,
      });
    },
  );

  it('resposta sem JSON (502 do proxy) diz que o serviço está indisponível, e não "Erro 502"', async () => {
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

    await expect(api.wallet()).rejects.toMatchObject({
      message: 'Serviço indisponível no momento. Tente de novo em instantes.',
      status: 502,
      code: undefined,
    });
  });

  it('falha de rede ("Failed to fetch") vira a mensagem de sem conexão, com status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const failure = await api.wallet().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({
      message: 'Sem conexão com o servidor. Confira sua internet e tente de novo.',
      status: 0,
      code: 'network_error',
    });
  });

  it('cancelamento (AbortError) não vira falha de rede: segue como veio', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));

    await expect(api.wallet()).rejects.toBe(abort);
  });

  it('mensagem da API vazia, que não é texto ou corpo null cai no texto do status', async () => {
    const replies = [
      { status: 500, body: { error: 'internal_error', message: '   ' } },
      { status: 404, body: { message: { texto: 'objeto' } } },
      { status: 429, body: null },
      { status: 413, body: ['lista'] },
    ];
    const fetchMock = vi.fn();
    for (const { status, body } of replies)
      fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.wallet()).rejects.toMatchObject({
      message: 'Serviço indisponível no momento. Tente de novo em instantes.',
      code: 'internal_error',
    });
    await expect(api.wallet()).rejects.toThrow('Não encontramos o que você pediu.');
    await expect(api.wallet()).rejects.toThrow(
      'Muitas tentativas. Tente novamente em alguns minutos.',
    );
    await expect(api.wallet()).rejects.toThrow('O envio passou do tamanho permitido.');
  });
});

describe('statusMessage', () => {
  it.each([
    [500, 'Serviço indisponível no momento. Tente de novo em instantes.'],
    [502, 'Serviço indisponível no momento. Tente de novo em instantes.'],
    [503, 'Serviço indisponível no momento. Tente de novo em instantes.'],
    [504, 'Serviço indisponível no momento. Tente de novo em instantes.'],
    [401, 'Sua sessão terminou. Entre de novo para continuar.'],
    [403, 'Você não tem permissão para fazer isso.'],
    [404, 'Não encontramos o que você pediu.'],
    [413, 'O envio passou do tamanho permitido.'],
    [429, 'Muitas tentativas. Tente novamente em alguns minutos.'],
    [400, 'Não foi possível concluir. Tente de novo.'],
    [409, 'Não foi possível concluir. Tente de novo.'],
    [422, 'Não foi possível concluir. Tente de novo.'],
  ])('%i → %s', (status, message) => {
    expect(statusMessage(status)).toBe(message);
  });

  it('as mensagens de rede e de indisponibilidade são as exportadas', () => {
    expect(NETWORK_ERROR_MESSAGE).toBe(
      'Sem conexão com o servidor. Confira sua internet e tente de novo.',
    );
    expect(UNAVAILABLE_MESSAGE).toBe(statusMessage(503));
  });
});
