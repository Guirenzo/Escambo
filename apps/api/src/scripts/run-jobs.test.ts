import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({
  poolEnd: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  captureError: vi.fn(),
  flushSentry: vi.fn(),
  initSentry: vi.fn(),
  runAllJobs: vi.fn(),
}));
vi.mock('../config/db', () => ({ pool: { end: h.poolEnd } }));
vi.mock('../config/logger', () => ({ logger: h.logger }));
vi.mock('../config/sentry', () => ({
  captureError: h.captureError,
  flushSentry: h.flushSentry,
  initSentry: h.initSentry,
}));
vi.mock('../jobs/scheduler', () => ({ runAllJobs: h.runAllJobs }));

/** Todos foram chamados, e a primeira chamada de cada um veio nessa ordem. */
const inOrder = (...fns: Array<{ mock: { invocationCallOrder: number[] } }>): void => {
  const order = fns.map((fn) => fn.mock.invocationCallOrder[0] ?? -1);
  // Quem não foi chamado não tem ordem: sem isto, o último da lista poderia faltar sem acusar.
  expect(order).not.toContain(-1);
  expect(order).toEqual([...order].sort((a, b) => a - b));
};

/**
 * `npm run jobs:run` (cron externo ou execução manual), com os jobs, o pool e o Sentry mockados:
 * roda todos os jobs UMA vez e sai — o código de saída é o que o cron enxerga.
 */
describe('script que roda os jobs uma vez', () => {
  let exit: MockInstance;

  /** Importa o script como o tsx o roda e espera ele pedir para sair. */
  async function runScript(): Promise<void> {
    vi.resetModules();
    await import('./run-jobs');
    await vi.waitFor(() => expect(exit.mock.calls.length).toBeGreaterThan(0));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    h.initSentry.mockResolvedValue(undefined);
    h.runAllJobs.mockResolvedValue(undefined);
    h.poolEnd.mockResolvedValue(undefined);
    h.flushSentry.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('inicia o Sentry, roda todos os jobs, fecha o pool, espera o envio dos erros e sai com 0', async () => {
    await runScript();

    // Sem argumento: é a lista padrão do agendador (todos os jobs), uma rodada só.
    expect(h.runAllJobs).toHaveBeenCalledTimes(1);
    expect(h.runAllJobs).toHaveBeenCalledWith();
    inOrder(h.initSentry, h.runAllJobs, h.poolEnd, h.flushSentry, exit);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it('se a rodada falha, registra, manda o erro ao Sentry, fecha o pool e sai com 1', async () => {
    const boom = new Error('pool sem conexão');
    h.runAllJobs.mockRejectedValue(boom);

    await runScript();

    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao rodar jobs']]);
    expect(h.captureError.mock.calls).toEqual([[boom]]);
    // O erro entra na fila antes de esperar o envio; senão sairia sem ele.
    inOrder(h.captureError, h.poolEnd, h.flushSentry, exit);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('rodada boa, mas o pool falha ao fechar: registra, manda ao Sentry e sai com 1 (o cron enxerga a falha)', async () => {
    const boom = new Error('pool já fechado');
    h.poolEnd.mockRejectedValueOnce(boom);

    await runScript();

    expect(h.runAllJobs).toHaveBeenCalledTimes(1);
    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao rodar jobs']]);
    expect(h.captureError.mock.calls).toEqual([[boom]]);
    // A espera do caminho normal foi pulada; a que roda é a de depois de enfileirar o erro.
    expect(h.flushSentry).toHaveBeenCalledTimes(1);
    inOrder(h.captureError, h.flushSentry, exit);
    // Uma única saída, com 1: o exit(0) do caminho normal não chegou a rodar.
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('Sentry que não inicia também é falha: os jobs não rodam e a saída é 1', async () => {
    const boom = new Error('DSN inválido');
    h.initSentry.mockRejectedValue(boom);

    await runScript();

    expect(h.runAllJobs).not.toHaveBeenCalled();
    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao rodar jobs']]);
    expect(h.captureError.mock.calls).toEqual([[boom]]);
    // O pool é fechado mesmo sem rodada: senão as conexões prenderiam o processo.
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('rodada que falha com o pool que também não fecha: ainda espera o Sentry e sai com 1', async () => {
    const boom = new Error('falhou');
    h.runAllJobs.mockRejectedValue(boom);
    h.poolEnd.mockRejectedValue(new Error('pool já fechado'));

    await runScript();

    // Só o erro da rodada é registrado; o do pool, no caminho de falha, é engolido.
    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao rodar jobs']]);
    expect(h.captureError.mock.calls).toEqual([[boom]]);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    inOrder(h.captureError, h.poolEnd, h.flushSentry, exit);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('na falha, o Sentry fora do ar não prende o processo: sai com 1 do mesmo jeito', async () => {
    h.runAllJobs.mockRejectedValue(new Error('falhou'));
    h.flushSentry.mockRejectedValue(new Error('timeout no envio'));

    await runScript();

    expect(h.flushSentry).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
