import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({
  poolEnd: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sealStoredWithdrawals: vi.fn(),
}));
vi.mock('../config/db', () => ({ pool: { end: h.poolEnd } }));
vi.mock('../config/logger', () => ({ logger: h.logger }));
vi.mock('../modules/withdrawal/withdrawal.backfill', () => ({
  sealStoredWithdrawals: h.sealStoredWithdrawals,
}));

/**
 * `npm run fields:encrypt`, com a cifragem dos saques e o pool mockados: roda UMA vez e sai. O
 * código de saída diz a quem rodou se ficou algo para resolver.
 */
describe('script que cifra o destino dos saques antigos (RNF-017)', () => {
  let exit: MockInstance;

  /** Importa o script como o tsx o roda e espera ele pedir para sair. */
  async function runScript(): Promise<void> {
    vi.resetModules();
    await import('./encrypt-withdrawal-fields');
    await vi.waitFor(() => expect(exit.mock.calls.length).toBeGreaterThan(0));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    h.poolEnd.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('cifra com o lote padrão, registra o resultado, fecha o pool e sai com 0', async () => {
    const result = { checked: 12, sealed: 12, unreadable: 0 };
    h.sealStoredWithdrawals.mockResolvedValue(result);

    await runScript();

    expect(h.sealStoredWithdrawals).toHaveBeenCalledTimes(1);
    expect(h.sealStoredWithdrawals).toHaveBeenCalledWith();
    expect(h.logger.info.mock.calls).toEqual([[result, 'Destino dos saques cifrado']]);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('sobrou valor que não decifra: o resto fica cifrado, e a saída 1 avisa', async () => {
    h.sealStoredWithdrawals.mockResolvedValue({ checked: 3, sealed: 2, unreadable: 1 });

    await runScript();

    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('sem a chave (ou com o banco fora), registra, fecha o pool e sai com 1', async () => {
    const boom = new Error('FIELD_ENCRYPTION_KEY não configurada: nada foi cifrado');
    h.sealStoredWithdrawals.mockRejectedValue(boom);

    await runScript();

    expect(h.logger.error.mock.calls).toEqual([
      [{ err: boom }, 'Falha ao cifrar o destino dos saques'],
    ]);
    expect(h.poolEnd).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('o pool que não fecha no caminho de falha não impede a saída com 1', async () => {
    h.sealStoredWithdrawals.mockResolvedValue({ checked: 0, sealed: 0, unreadable: 0 });
    h.poolEnd.mockRejectedValue(new Error('pool já fechado'));

    await runScript();

    // O fechamento do caminho normal falhou; o do caminho de falha é tentado e engolido.
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.poolEnd).toHaveBeenCalledTimes(2);
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
