import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermético: o .env local de quem roda não pode trazer de volta o que o teste apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * Login com Google (RF-002) na subida: desligado por padrão; o client id sem o segredo (ou o
 * contrário) não sobe; o endereço de volta tem de ser http(s) completo; e o Google falso dos
 * testes só aceita um endereço da própria máquina.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

async function refused(): Promise<Record<string, string[]>> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await expect(loadEnv()).rejects.toThrow('exit 1');
  expect(exit.mock.calls).toEqual([[1]]);
  return error.mock.calls[1]?.[0] as Record<string, string[]>;
}

const ID = 'cliente-de-teste.apps.googleusercontent.com';
const SECRET = 'segredo-de-teste-do-google-com-32-caracteres';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('variáveis do login com Google', () => {
  it('padrão: tudo vazio (desligado)', async () => {
    for (const key of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REDIRECT_URI',
      'GOOGLE_TEST_IDP_URL',
    ]) {
      vi.stubEnv(key, undefined);
    }
    const env = await loadEnv();
    expect([
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
      env.GOOGLE_TEST_IDP_URL,
    ]).toEqual(['', '', '', '']);
  });

  it('os dois juntos sobem (aparados), com o endereço de volta e o Google falso local', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', ` ${ID} `);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', SECRET);
    vi.stubEnv('GOOGLE_REDIRECT_URI', 'https://escambo.example/api/auth/google/callback');
    vi.stubEnv('GOOGLE_TEST_IDP_URL', 'http://127.0.0.1:4010');
    const env = await loadEnv();
    expect(env.GOOGLE_CLIENT_ID).toBe(ID);
    expect(env.GOOGLE_REDIRECT_URI).toBe('https://escambo.example/api/auth/google/callback');
    expect(env.GOOGLE_TEST_IDP_URL).toBe('http://127.0.0.1:4010');
    for (const local of ['http://localhost:1', 'http://[::1]:9']) {
      vi.stubEnv('GOOGLE_TEST_IDP_URL', local);
      expect((await loadEnv()).GOOGLE_TEST_IDP_URL).toBe(local);
    }
  });

  it('o id sem o segredo, ou o segredo sem o id, não sobe, e diz qual falta', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', ID);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const a = await refused();
    expect(a.GOOGLE_CLIENT_SECRET?.[0]).toContain('falta GOOGLE_CLIENT_SECRET');

    vi.restoreAllMocks();
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', SECRET);
    const b = await refused();
    expect(b.GOOGLE_CLIENT_ID?.[0]).toContain('falta GOOGLE_CLIENT_ID');
    // O segredo nunca aparece na mensagem.
    expect(JSON.stringify(b)).not.toContain(SECRET);
  });

  it('endereço de volta que não é http(s) completo, com usuário ou com fragmento, não sobe', async () => {
    for (const bad of [
      '/api/auth/google/callback',
      'ftp://escambo.example/cb',
      'https://user:senha@escambo.example/cb',
      'https://escambo.example/cb#x',
    ]) {
      vi.restoreAllMocks();
      vi.stubEnv('GOOGLE_REDIRECT_URI', bad);
      expect((await refused()).GOOGLE_REDIRECT_URI?.[0]).toContain('GOOGLE_REDIRECT_URI');
    }
  });

  it('o Google falso fora da própria máquina não sobe', async () => {
    for (const bad of [
      'https://accounts.evil.example',
      'http://10.0.0.5:4010',
      'nada',
      'file:///x',
    ]) {
      vi.restoreAllMocks();
      vi.stubEnv('GOOGLE_TEST_IDP_URL', bad);
      expect((await refused()).GOOGLE_TEST_IDP_URL?.[0]).toContain('própria máquina');
    }
  });
});
