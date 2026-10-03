import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildInfo } from './config/build-info';
import { env } from './config/env';

const h = vi.hoisted(() => ({
  app: { fake: 'express-app' },
  server: { listen: vi.fn(), close: vi.fn(), listening: true },
  io: { close: vi.fn() },
  metricsServer: { close: vi.fn() },
  createServer: vi.fn(),
  createApp: vi.fn(),
  hydrate: vi.fn(),
  pingDb: vi.fn(),
  poolEnd: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  startMetricsServer: vi.fn(),
  captureError: vi.fn(),
  flushSentry: vi.fn(),
  initSentry: vi.fn(),
  createSocketServer: vi.fn(),
  startJobs: vi.fn(),
  stopJobs: vi.fn(),
}));
vi.mock('node:http', () => ({
  createServer: h.createServer,
  default: { createServer: h.createServer },
}));
vi.mock('./app', () => ({ createApp: h.createApp }));
vi.mock('./config/blocklist', () => ({ blocklist: { hydrate: h.hydrate } }));
vi.mock('./config/db', () => ({ pingDb: h.pingDb, pool: { end: h.poolEnd } }));
vi.mock('./config/logger', () => ({ logger: h.logger }));
vi.mock('./config/metrics', () => ({ startMetricsServer: h.startMetricsServer }));
vi.mock('./config/sentry', () => ({
  captureError: h.captureError,
  flushSentry: h.flushSentry,
  initSentry: h.initSentry,
}));
vi.mock('./config/socket', () => ({ createSocketServer: h.createSocketServer }));
vi.mock('./jobs/scheduler', () => ({ startJobs: h.startJobs, stopJobs: h.stopJobs }));

type Handler = (...args: unknown[]) => void;
type Called = { mock: { invocationCallOrder: number[] } };

/** Os eventos do processo que o servidor escuta: ficam guardados aqui, fora do processo do teste. */
const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'];
const RETRY_MS = 1500;

/** Todos foram chamados, e a primeira chamada de cada um veio nessa ordem. */
const inOrder = (...fns: Called[]): void => {
  const order = fns.map((fn) => fn.mock.invocationCallOrder[0] ?? -1);
  // Quem não foi chamado não tem ordem: sem isto, o último da lista poderia faltar sem acusar.
  expect(order).not.toContain(-1);
  expect(order).toEqual([...order].sort((a, b) => a - b));
};

/**
 * Ponto de entrada da API (server.ts) com tudo em volta mockado — HTTP, banco, sockets, métricas,
 * Sentry e jobs — e o relógio falso: nenhuma porta é aberta e nenhum timer sobra. O que se confere
 * é a ordem da subida, a espera pelo banco e o encerramento gracioso.
 */
describe('servidor da API', () => {
  const handlers = new Map<string, Handler>();
  let exit: MockInstance;
  let onListening: (() => void) | undefined;

  /** Deixa as promessas pendentes andarem, sem avançar o relógio. */
  const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

  /** Importa o server.ts como o `node dist/server.js` o roda e deixa a subida andar. */
  async function boot(): Promise<void> {
    vi.resetModules();
    await import('./server');
    await settle();
  }

  /** Dispara um evento do processo no handler que o servidor registrou. */
  async function emit(event: string, ...args: unknown[]): Promise<void> {
    handlers.get(event)!(...args);
    await settle();
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    handlers.clear();
    onListening = undefined;

    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const realOn = process.on.bind(process) as (event: string, listener: Handler) => NodeJS.Process;
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: Handler) => {
      if (!PROCESS_EVENTS.includes(event)) return realOn(event, listener);
      handlers.set(event, listener);
      return process;
    }) as never);

    h.initSentry.mockResolvedValue(undefined);
    h.pingDb.mockResolvedValue(undefined);
    h.hydrate.mockResolvedValue(0);
    h.createApp.mockReturnValue(h.app);
    h.createServer.mockReturnValue(h.server);
    h.createSocketServer.mockReturnValue(h.io);
    h.startMetricsServer.mockReturnValue(h.metricsServer);
    h.server.listening = true;
    h.server.listen.mockImplementation((_port: number, callback: () => void) => {
      onListening = callback;
      return h.server;
    });
    h.server.close.mockImplementation((callback: (err?: Error) => void) => callback());
    h.io.close.mockResolvedValue(undefined);
    h.flushSentry.mockResolvedValue(undefined);
    h.poolEnd.mockResolvedValue(undefined);
  });
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('subida', () => {
    it('espera o banco, hidrata a lista de bloqueio e só então monta o app, os sockets e as métricas e abre a porta', async () => {
      await boot();

      inOrder(
        h.initSentry,
        h.pingDb,
        h.hydrate,
        h.createApp,
        h.createServer,
        h.createSocketServer,
        h.startMetricsServer,
        h.server.listen,
      );
      expect(h.createServer).toHaveBeenCalledWith(h.app);
      // O chat usa o MESMO servidor HTTP da API.
      expect(h.createSocketServer).toHaveBeenCalledWith(h.server);
      expect(h.startMetricsServer).toHaveBeenCalledWith(env.METRICS_PORT);
      expect(h.server.listen).toHaveBeenCalledTimes(1);
      expect(h.server.listen.mock.calls[0]![0]).toBe(env.PORT);
      expect(exit).not.toHaveBeenCalled();
    });

    it('os jobs só começam depois que a porta está aberta, e a subida registra a versão e o commit no ar', async () => {
      await boot();
      expect(h.startJobs).not.toHaveBeenCalled();
      expect(h.logger.info).not.toHaveBeenCalled();

      onListening!();

      expect(h.startJobs).toHaveBeenCalledTimes(1);
      expect(h.logger.info.mock.calls).toEqual([
        [
          { version: buildInfo.version, commit: buildInfo.commit },
          `API Escambo em http://localhost:${env.PORT}/api (env: ${env.NODE_ENV})`,
        ],
      ]);
    });

    it('escuta os sinais de encerramento e as falhas não tratadas do processo', async () => {
      await boot();
      expect([...handlers.keys()].sort()).toEqual([...PROCESS_EVENTS].sort());
    });

    it('banco fora na subida: tenta de novo a cada 1,5 s, avisando, e sobe quando ele responde', async () => {
      h.pingDb
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await boot();
      expect(h.pingDb).toHaveBeenCalledTimes(1);
      expect(h.hydrate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      expect(h.pingDb).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.pingDb).toHaveBeenCalledTimes(2);
      expect(h.server.listen).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(h.pingDb).toHaveBeenCalledTimes(3);
      expect(h.hydrate).toHaveBeenCalledTimes(1);
      expect(h.server.listen).toHaveBeenCalledTimes(1);
      expect(h.logger.warn.mock.calls).toEqual([
        ['Banco indisponível (tentativa 1/10); nova tentativa em 1500ms'],
        ['Banco indisponível (tentativa 2/10); nova tentativa em 1500ms'],
      ]);
      expect(exit).not.toHaveBeenCalled();
    });

    it('banco que não volta em 10 tentativas: registra, manda ao Sentry e sai com 1, sem abrir a porta', async () => {
      const boom = new Error('ECONNREFUSED');
      h.pingDb.mockRejectedValue(boom);

      await boot();
      await vi.advanceTimersByTimeAsync(8 * RETRY_MS);
      expect(h.pingDb).toHaveBeenCalledTimes(9);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS);

      expect(h.pingDb).toHaveBeenCalledTimes(10);
      // A última tentativa não avisa "nova tentativa": ela é a falha.
      expect(h.logger.warn).toHaveBeenCalledTimes(9);
      expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao iniciar a API']]);
      expect(h.captureError.mock.calls).toEqual([[boom]]);
      inOrder(h.captureError, h.flushSentry, exit);
      expect(exit.mock.calls).toEqual([[1]]);
      expect(h.hydrate).not.toHaveBeenCalled();
      expect(h.createApp).not.toHaveBeenCalled();
      expect(h.server.listen).not.toHaveBeenCalled();
      expect(h.startJobs).not.toHaveBeenCalled();
    });

    it('falha na subida com o Sentry fora do ar ainda sai com 1', async () => {
      h.hydrate.mockRejectedValue(new Error('falhou'));
      h.flushSentry.mockRejectedValue(new Error('timeout no envio'));

      await boot();

      expect(h.flushSentry).toHaveBeenCalledTimes(1);
      expect(exit.mock.calls).toEqual([[1]]);
      expect(h.server.listen).not.toHaveBeenCalled();
    });
  });

  describe('encerramento gracioso', () => {
    it('SIGTERM: para os jobs, fecha métricas, esvazia o Sentry, fecha sockets e HTTP, depois o pool, e sai com 0', async () => {
      await boot();

      await emit('SIGTERM');

      inOrder(
        h.stopJobs,
        h.metricsServer.close,
        h.flushSentry,
        h.io.close,
        h.server.close,
        h.poolEnd,
        exit,
      );
      expect(h.logger.info.mock.calls).toEqual([
        [{ signal: 'SIGTERM' }, 'Encerrando a API…'],
        ['API encerrada com sucesso'],
      ]);
      expect(h.poolEnd).toHaveBeenCalledTimes(1);
      expect(exit.mock.calls).toEqual([[0]]);
      expect(h.logger.error).not.toHaveBeenCalled();
      expect(h.captureError).not.toHaveBeenCalled();
    });

    it('SIGINT (Ctrl+C) encerra do mesmo jeito', async () => {
      await boot();

      await emit('SIGINT');

      expect(h.logger.info.mock.calls[0]).toEqual([{ signal: 'SIGINT' }, 'Encerrando a API…']);
      expect(h.stopJobs).toHaveBeenCalledTimes(1);
      expect(exit.mock.calls).toEqual([[0]]);
    });

    it('se o socket.io já fechou o servidor HTTP, não tenta fechar de novo', async () => {
      await boot();
      h.io.close.mockImplementation(async () => {
        h.server.listening = false;
      });

      await emit('SIGTERM');

      expect(h.server.close).not.toHaveBeenCalled();
      expect(h.poolEnd).toHaveBeenCalledTimes(1);
      expect(exit.mock.calls).toEqual([[0]]);
    });

    it('sem o servidor de métricas (METRICS_PORT 0), encerra normalmente', async () => {
      h.startMetricsServer.mockReturnValue(null);
      await boot();

      await emit('SIGTERM');

      expect(h.metricsServer.close).not.toHaveBeenCalled();
      expect(exit.mock.calls).toEqual([[0]]);
    });

    it('um segundo sinal durante o encerramento é ignorado', async () => {
      await boot();
      let release = (): void => undefined;
      h.io.close.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));

      await emit('SIGTERM');
      await emit('SIGINT');
      await emit('SIGTERM');
      expect(exit).not.toHaveBeenCalled();

      release();
      await settle();

      expect(h.stopJobs).toHaveBeenCalledTimes(1);
      expect(h.io.close).toHaveBeenCalledTimes(1);
      expect(h.poolEnd).toHaveBeenCalledTimes(1);
      expect(exit.mock.calls).toEqual([[0]]);
    });

    it('falha ao fechar o pool: registra, manda ao Sentry, espera o envio e sai com 1', async () => {
      const boom = new Error('pool já fechado');
      h.poolEnd.mockRejectedValue(boom);
      await boot();

      await emit('SIGTERM');

      expect(h.logger.error.mock.calls).toEqual([
        [{ err: boom }, 'Falha no encerramento gracioso'],
      ]);
      expect(h.captureError.mock.calls).toEqual([[boom]]);
      // Uma espera no caminho normal e outra depois de enfileirar o erro do encerramento.
      expect(h.flushSentry).toHaveBeenCalledTimes(2);
      expect(h.captureError.mock.invocationCallOrder[0]!).toBeLessThan(
        h.flushSentry.mock.invocationCallOrder[1]!,
      );
      expect(exit.mock.calls).toEqual([[1]]);
      // O timer do encerramento forçado ficou armado (o processo real já teria saído).
      vi.clearAllTimers();
    });

    it('na falha de encerramento, o Sentry fora do ar não prende o processo: sai com 1', async () => {
      h.poolEnd.mockRejectedValue(new Error('pool já fechado'));
      // A primeira espera (caminho normal) passa; a segunda, depois do erro, falha.
      h.flushSentry.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timeout'));
      await boot();

      await emit('SIGTERM');

      expect(h.flushSentry).toHaveBeenCalledTimes(2);
      expect(exit.mock.calls).toEqual([[1]]);
      vi.clearAllTimers();
    });

    it('servidor HTTP que falha ao fechar também é falha de encerramento: sai com 1 e não fecha o pool', async () => {
      const boom = new Error('ERR_SERVER_NOT_RUNNING');
      h.server.close.mockImplementation((callback: (err?: Error) => void) => callback(boom));
      await boot();

      await emit('SIGTERM');

      expect(h.captureError.mock.calls).toEqual([[boom]]);
      expect(h.poolEnd).not.toHaveBeenCalled();
      expect(exit.mock.calls).toEqual([[1]]);
      vi.clearAllTimers();
    });

    it('encerramento que não termina em SHUTDOWN_TIMEOUT_MS é forçado com saída 1', async () => {
      h.io.close.mockImplementation(() => new Promise<void>(() => undefined));
      await boot();

      await emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(env.SHUTDOWN_TIMEOUT_MS - 1);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(h.logger.error.mock.calls).toEqual([
        ['Encerramento gracioso excedeu o tempo; forçando saída'],
      ]);
      expect(exit.mock.calls).toEqual([[1]]);
      expect(h.poolEnd).not.toHaveBeenCalled();
    });

    it('o timer da saída forçada não segura o processo vivo (unref) e vale SHUTDOWN_TIMEOUT_MS', async () => {
      h.io.close.mockImplementation(() => new Promise<void>(() => undefined));
      await boot();
      // Controle: no relógio falso, um timer comum nasce com ref (senão a checagem abaixo não diria nada).
      const control = setTimeout(() => undefined, 1);
      expect(control.hasRef()).toBe(true);
      clearTimeout(control);
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      try {
        await emit('SIGTERM');

        const delays = setTimer.mock.calls.map((call) => call[1]);
        const at = delays.indexOf(env.SHUTDOWN_TIMEOUT_MS);
        expect(at).toBeGreaterThan(-1);
        const forced = setTimer.mock.results[at]!.value as NodeJS.Timeout;
        // Com ref, um encerramento que já terminou ainda esperaria o timer para o processo sair.
        expect(forced.hasRef()).toBe(false);
      } finally {
        // Antes do afterEach: o spy está por cima do relógio falso, que sai primeiro.
        setTimer.mockRestore();
        vi.clearAllTimers();
      }
    });

    it('encerramento que termina a tempo desarma a saída forçada', async () => {
      await boot();

      await emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(env.SHUTDOWN_TIMEOUT_MS * 2);

      expect(exit.mock.calls).toEqual([[0]]);
      expect(h.logger.error).not.toHaveBeenCalled();
    });
  });

  describe('falha não tratada', () => {
    it('promise rejeitada sem tratamento: registra, manda ao Sentry e encerra drenando as conexões', async () => {
      await boot();
      const reason = new Error('rejeição solta');

      await emit('unhandledRejection', reason);

      expect(h.logger.error.mock.calls).toEqual([
        [{ err: reason }, 'Promise rejeitada sem tratamento — encerrando'],
      ]);
      expect(h.captureError.mock.calls).toEqual([[reason]]);
      // O erro entra na fila do Sentry antes de o encerramento esperar o envio.
      inOrder(h.captureError, h.stopJobs, h.flushSentry, h.poolEnd, exit);
      expect(h.logger.info.mock.calls[0]).toEqual([
        { signal: 'unhandledRejection' },
        'Encerrando a API…',
      ]);
      expect(exit.mock.calls).toEqual([[0]]);
    });

    it('exceção não capturada: registra como fatal, manda ao Sentry e encerra', async () => {
      await boot();
      const err = new TypeError('x is not a function');

      await emit('uncaughtException', err);

      expect(h.logger.fatal.mock.calls).toEqual([[{ err }, 'Exceção não capturada — encerrando']]);
      expect(h.captureError.mock.calls).toEqual([[err]]);
      inOrder(h.captureError, h.stopJobs, h.flushSentry, h.poolEnd, exit);
      expect(h.logger.info.mock.calls[0]).toEqual([
        { signal: 'uncaughtException' },
        'Encerrando a API…',
      ]);
      expect(exit.mock.calls).toEqual([[0]]);
    });
  });
});
