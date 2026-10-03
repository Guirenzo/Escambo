import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOBS_INTERVAL_MAX_MS, REMINDER_SLOT_MIN_LEFT_MS } from '../utils/human-hours';

// Hermético: um JOBS_INTERVAL_MS no .env local de quem roda não pode voltar quando o teste o apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * O intervalo dos jobs tem teto (ADR 58): o slot do lembrete no próprio dia conta com pelo menos
 * uma rodada antes das 2 h finais. O env.ts lê o teto de utils/human-hours.ts, e um intervalo
 * maior não deixa a API subir. O módulo é carregado de novo com o ambiente já ajustado.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('intervalo dos jobs (ADR 58)', () => {
  it('o teto é 30 minutos, e o slot do próprio dia pede 2 h 30 pela frente (2 h da emissão + o teto)', () => {
    expect(JOBS_INTERVAL_MAX_MS).toBe(30 * 60_000);
    expect(REMINDER_SLOT_MIN_LEFT_MS).toBe(150 * 60_000);
  });

  it('sem valor, 5 minutos; exatamente o teto, aceito', async () => {
    vi.stubEnv('JOBS_INTERVAL_MS', undefined);
    expect((await loadEnv()).JOBS_INTERVAL_MS).toBe(5 * 60_000);

    vi.stubEnv('JOBS_INTERVAL_MS', String(30 * 60_000));
    expect((await loadEnv()).JOBS_INTERVAL_MS).toBe(30 * 60_000);
  });

  it('um milissegundo acima do teto e a API não sobe: mostra o campo e sai com 1', async () => {
    vi.stubEnv('JOBS_INTERVAL_MS', String(30 * 60_000 + 1));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(loadEnv()).rejects.toThrow('exit 1');

    expect(exit.mock.calls).toEqual([[1]]);
    expect(error.mock.calls).toEqual([
      ['❌ Variáveis de ambiente inválidas:'],
      [{ JOBS_INTERVAL_MS: ['Number must be less than or equal to 1800000'] }],
    ]);
  });
});
