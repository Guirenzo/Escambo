import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({
  poolEnd: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  reevaluateAll: vi.fn(),
}));
vi.mock('../config/db', () => ({ pool: { end: h.poolEnd } }));
vi.mock('../config/logger', () => ({ logger: h.logger }));
vi.mock('../modules/gamification/gamification.service', () => ({
  gamificationService: { reevaluateAll: h.reevaluateAll },
}));

/**
 * `npm run badges:reevaluate`, com a gamificação e o pool mockados: reavalia todo mundo UMA vez e
 * sai. O código de saída diz a quem rodou se precisa rodar de novo.
 */
describe('script que reavalia as badges uma vez', () => {
  let exit: MockInstance;

  /** Importa o script como o tsx o roda e espera ele pedir para sair. */
  async function runScript(): Promise<void> {
    vi.resetModules();
    await import('./reevaluate-badges');
    await vi.waitFor(() => expect(exit.mock.calls.length).toBeGreaterThan(0));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    h.poolEnd.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reavalia com o lote padrão, registra o resultado, fecha o pool e sai com 0', async () => {
    const result = { evaluated: 12, awarded: 3, failed: 0 };
    h.reevaluateAll.mockResolvedValue(result);

    await runScript();

    expect(h.reevaluateAll).toHaveBeenCalledTimes(1);
    expect(h.reevaluateAll).toHaveBeenCalledWith();
    expect(h.logger.info.mock.calls).toEqual([[result, 'Badges reavaliadas']]);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('alguém falhou: o que deu certo fica, e a saída 1 pede outra rodada', async () => {
    h.reevaluateAll.mockResolvedValue({ evaluated: 4, awarded: 1, failed: 2 });

    await runScript();

    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('se a reavaliação falha inteira, registra, fecha o pool e sai com 1', async () => {
    const boom = new Error('pool sem conexão');
    h.reevaluateAll.mockRejectedValue(boom);

    await runScript();

    expect(h.logger.error.mock.calls).toEqual([[{ err: boom }, 'Falha ao reavaliar as badges']]);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('o pool que não fecha no caminho de falha não impede a saída com 1', async () => {
    h.reevaluateAll.mockResolvedValue({ evaluated: 1, awarded: 0, failed: 0 });
    h.poolEnd.mockRejectedValue(new Error('pool já fechado'));

    await runScript();

    // O fechamento do caminho normal falhou; o do caminho de falha é tentado e engolido.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.poolEnd).toHaveBeenCalledTimes(2);
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
