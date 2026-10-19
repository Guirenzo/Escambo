import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermético: uma chave no .env local de quem roda não pode voltar quando o teste a apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * Chave da cifragem de campo (RNF-017) na subida: vazia é aceita (texto puro, como antes); com
 * valor, tem de ser 32 bytes em base64, ou a API não sobe — e a mensagem nunca repete a chave.
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
  return error.mock.calls[1]?.[0];
}

const KEY = Buffer.alloc(32, 0x61).toString('base64');
const OLD = Buffer.alloc(32, 0x62).toString('base64');
const HINT = '32 bytes em base64 (gere com "openssl rand -base64 32")';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('FIELD_ENCRYPTION_KEY na subida (RNF-017)', () => {
  it('ausente ou vazia: sobe sem chave (texto puro, como antes)', async () => {
    vi.stubEnv('FIELD_ENCRYPTION_KEY', undefined);
    vi.stubEnv('FIELD_ENCRYPTION_OLD_KEYS', undefined);
    let env = await loadEnv();
    expect(env.FIELD_ENCRYPTION_KEY).toBe('');
    expect(env.FIELD_ENCRYPTION_OLD_KEYS).toBe('');

    // O compose passa a variável vazia quando o .env não a tem.
    vi.stubEnv('FIELD_ENCRYPTION_KEY', '  ');
    env = await loadEnv();
    expect(env.FIELD_ENCRYPTION_KEY).toBe('');
  });

  it('32 bytes em base64 sobem, aparados', async () => {
    vi.stubEnv('FIELD_ENCRYPTION_KEY', ` ${KEY}\n`);
    vi.stubEnv('FIELD_ENCRYPTION_OLD_KEYS', `${OLD}, ${KEY}`);

    const env = await loadEnv();
    expect(env.FIELD_ENCRYPTION_KEY).toBe(KEY);
    expect(env.FIELD_ENCRYPTION_OLD_KEYS).toBe(`${OLD}, ${KEY}`);
  });

  it.each([
    ['16 bytes (AES-128)', Buffer.alloc(16, 1).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64')],
    ['texto qualquer', 'minha-chave-secreta-de-producao!'],
    ['base64 sem o "="', KEY.replace(/=$/, '')],
    ['base64url', Buffer.alloc(32, 0xfb).toString('base64url')],
    ['hex de 32 bytes', Buffer.alloc(32, 1).toString('hex')],
  ])('%s não sobe, e o erro não mostra a chave', async (_case, value) => {
    vi.stubEnv('FIELD_ENCRYPTION_KEY', value);

    const fields = await refused();
    expect(fields).toEqual({ FIELD_ENCRYPTION_KEY: [`FIELD_ENCRYPTION_KEY deve ter ${HINT}`] });
    expect(JSON.stringify(fields)).not.toContain(value);
  });

  it('chave antiga inválida também não sobe', async () => {
    vi.stubEnv('FIELD_ENCRYPTION_KEY', KEY);
    vi.stubEnv('FIELD_ENCRYPTION_OLD_KEYS', `${OLD},curta`);

    expect(await refused()).toEqual({
      FIELD_ENCRYPTION_OLD_KEYS: [`cada chave de FIELD_ENCRYPTION_OLD_KEYS deve ter ${HINT}`],
    });
  });
});
