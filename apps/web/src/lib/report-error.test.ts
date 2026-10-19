import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api';
import { installErrorReporting, reportClientError, resetErrorReporting } from './report-error';

/**
 * Relato de erro do navegador (RNF-040): vai à API sem atrapalhar a tela, sem a query string,
 * no máximo 5 por página e uma vez por erro; a recusa da API e a falta de rede não contam.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  resetErrorReporting();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/redefinir-senha?token=segredo#topo');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const sentBody = (call = 0): Record<string, unknown> =>
  JSON.parse(fetchMock.mock.calls[call]![1].body as string) as Record<string, unknown>;

describe('reportClientError', () => {
  it('manda o erro à API com o tipo, a mensagem, as pilhas e só o caminho da tela', () => {
    const err = new TypeError('Saldo veio sem valor');
    reportClientError('render', err, '\n    at CarteiraView');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/client-errors');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
    expect(sentBody()).toEqual({
      kind: 'render',
      message: 'Saldo veio sem valor',
      stack: err.stack,
      componentStack: '\n    at CarteiraView',
      path: '/redefinir-senha',
    });
    expect(String(init.body)).not.toContain('segredo');
  });

  it('valor que não é Error vira mensagem; sem pilha de componentes, o campo não vai', () => {
    reportClientError('rejection', 'recusou sem motivo');
    const body = sentBody();
    expect(body.message).toBe('recusou sem motivo');
    expect(body).not.toHaveProperty('componentStack');
  });

  it('o mesmo erro vai uma vez só; outro tipo ou outra mensagem vai de novo', () => {
    reportClientError('error', new Error('a'));
    reportClientError('error', new Error('a'));
    reportClientError('rejection', new Error('a'));
    reportClientError('error', new Error('b'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('para depois de 5 relatos por página aberta', () => {
    for (let i = 0; i < 9; i++) reportClientError('error', new Error(`erro ${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      'recusa da API (ela mesma já registrou)',
      new ApiRequestError('Sem permissão', 403, 'forbidden'),
    ],
    ['falta de rede', new TypeError('Failed to fetch')],
    [
      'aviso do ResizeObserver',
      new Error('ResizeObserver loop completed with undelivered notifications.'),
    ],
  ])('%s não é relatada', (_caso, error) => {
    reportClientError('rejection', error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mensagem e pilha enormes vão cortadas', () => {
    const err = new Error('m'.repeat(900));
    err.stack = 's'.repeat(9000);
    reportClientError('error', err, 'c'.repeat(9000));
    const body = sentBody();
    expect(body.message).toHaveLength(500);
    expect(body.stack).toHaveLength(4000);
    expect(body.componentStack).toHaveLength(4000);
  });

  it('API fora do ar ou fetch que explode não quebram quem relatou', async () => {
    fetchMock.mockRejectedValueOnce(new Error('sem rede'));
    expect(() => reportClientError('error', new Error('um'))).not.toThrow();
    fetchMock.mockImplementationOnce(() => {
      throw new Error('fetch quebrado');
    });
    expect(() => reportClientError('error', new Error('dois'))).not.toThrow();
    await Promise.resolve();
  });
});

describe('installErrorReporting', () => {
  it('relata o erro de script do próprio app e a promessa rejeitada sem catch', () => {
    const stop = installErrorReporting();
    const own = new Error('quebrou no app');
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: own,
        message: own.message,
        filename: `${window.location.origin}/assets/index.js`,
      }),
    );
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('promessa sem catch') });
    window.dispatchEvent(rejection);
    stop();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0)).toMatchObject({ kind: 'error', message: 'quebrou no app' });
    expect(sentBody(1)).toMatchObject({ kind: 'rejection', message: 'promessa sem catch' });
  });

  it('erro de extensão ou de outro domínio ("Script error." sem arquivo) fica de fora', () => {
    const stop = installErrorReporting();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'x',
        filename: 'chrome-extension://abc/content.js',
      }),
    );
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sem o objeto do erro, usa a mensagem do evento', () => {
    const stop = installErrorReporting();
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'só a mensagem',
        filename: `${window.location.origin}/assets/index.js`,
      }),
    );
    stop();
    expect(sentBody()).toMatchObject({ kind: 'error', message: 'só a mensagem' });
  });

  it('depois de parar, não ouve mais', () => {
    const stop = installErrorReporting();
    stop();
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'depois',
        filename: `${window.location.origin}/assets/index.js`,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
