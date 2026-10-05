import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermético: chaves VAPID no .env local de quem roda não podem voltar quando o teste as apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * Push de verdade (ADR 52) sem o par VAPID não sobe: o erro aparece na subida, com o nome da
 * chave que falta, e não no primeiro aviso. O módulo é carregado de novo com o ambiente ajustado.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

/** Espera a API recusar a subida e devolve o que ela mostrou dos campos. */
async function refused(): Promise<unknown> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await expect(loadEnv()).rejects.toThrow('exit 1');

  expect(exit.mock.calls).toEqual([[1]]);
  expect(error.mock.calls[0]).toEqual(['❌ Variáveis de ambiente inválidas:']);
  return error.mock.calls[1]?.[0];
}

const HINT = '(gere o par com "npx web-push generate-vapid-keys")';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('chaves do Web Push na subida (ADR 52)', () => {
  it('PUSH_PROVIDER=webpush sem as duas chaves não sobe: aponta as duas', async () => {
    vi.stubEnv('PUSH_PROVIDER', 'webpush');
    vi.stubEnv('PUSH_PUBLIC_KEY', undefined);
    vi.stubEnv('PUSH_PRIVATE_KEY', undefined);

    expect(await refused()).toEqual({
      PUSH_PUBLIC_KEY: [`PUSH_PROVIDER=webpush exige PUSH_PUBLIC_KEY ${HINT}`],
      PUSH_PRIVATE_KEY: [`PUSH_PROVIDER=webpush exige PUSH_PRIVATE_KEY ${HINT}`],
    });
  });

  it('só a pública não basta, e chave só com espaços conta como ausente', async () => {
    vi.stubEnv('PUSH_PROVIDER', 'webpush');
    vi.stubEnv('PUSH_PUBLIC_KEY', 'chave-publica');
    vi.stubEnv('PUSH_PRIVATE_KEY', '   ');

    expect(await refused()).toEqual({
      PUSH_PRIVATE_KEY: [`PUSH_PROVIDER=webpush exige PUSH_PRIVATE_KEY ${HINT}`],
    });
  });

  it('com as duas chaves, sobe com elas', async () => {
    vi.stubEnv('PUSH_PROVIDER', 'webpush');
    vi.stubEnv('PUSH_PUBLIC_KEY', 'chave-publica');
    vi.stubEnv('PUSH_PRIVATE_KEY', 'chave-privada');

    const env = await loadEnv();
    expect(env.PUSH_PROVIDER).toBe('webpush');
    expect(env.PUSH_PUBLIC_KEY).toBe('chave-publica');
    expect(env.PUSH_PRIVATE_KEY).toBe('chave-privada');
  });

  it('chave com espaço ou quebra de linha nas pontas sobe aparada: o web-push recebe só a chave', async () => {
    vi.stubEnv('PUSH_PROVIDER', 'webpush');
    vi.stubEnv('PUSH_PUBLIC_KEY', ' BKx-chave-publica ');
    vi.stubEnv('PUSH_PRIVATE_KEY', '\tchave-privada\n');

    const env = await loadEnv();
    expect(env.PUSH_PUBLIC_KEY).toBe('BKx-chave-publica');
    expect(env.PUSH_PRIVATE_KEY).toBe('chave-privada');
  });

  it('simulado e desligado não pedem chave: o simulado gera um par de demonstração', async () => {
    vi.stubEnv('PUSH_PUBLIC_KEY', undefined);
    vi.stubEnv('PUSH_PRIVATE_KEY', undefined);

    vi.stubEnv('PUSH_PROVIDER', 'simulated');
    expect((await loadEnv()).PUSH_PROVIDER).toBe('simulated');

    vi.stubEnv('PUSH_PROVIDER', 'off');
    expect((await loadEnv()).PUSH_PROVIDER).toBe('off');
  });
});
