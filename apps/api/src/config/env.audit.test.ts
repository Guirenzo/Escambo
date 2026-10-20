import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermético: um AUDIT_LOG_PURGE_DAYS no .env local de quem roda não pode voltar quando o teste o apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * Expurgo do audit_logs (RNF-037): desligado sem valor, e prazo abaixo da retenção mínima de 90 dias
 * não deixa a API subir. O módulo é carregado de novo com o ambiente já ajustado.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AUDIT_LOG_PURGE_DAYS (RNF-037)', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['90', 90],
    ['180', 180],
  ])('%j vira %i (0 = expurgo desligado)', async (value, expected) => {
    vi.stubEnv('AUDIT_LOG_PURGE_DAYS', value);
    expect((await loadEnv()).AUDIT_LOG_PURGE_DAYS).toBe(expected);
  });

  it.each(['1', '30', '89'])(
    '%s dias é menos que a retenção mínima: a API não sobe e diz por quê',
    async (value) => {
      vi.stubEnv('AUDIT_LOG_PURGE_DAYS', value);
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${String(code)}`);
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(loadEnv()).rejects.toThrow('exit 1');

      expect(exit.mock.calls).toEqual([[1]]);
      expect(error.mock.calls).toEqual([
        ['❌ Variáveis de ambiente inválidas:'],
        [
          {
            AUDIT_LOG_PURGE_DAYS: [
              'AUDIT_LOG_PURGE_DAYS deve ser 0 (desligado) ou pelo menos 90 dias (RNF-037)',
            ],
          },
        ],
      ]);
    },
  );
});
