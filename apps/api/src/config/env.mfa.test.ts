import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermético: o .env local de quem roda não pode trazer de volta o que o teste apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * ADMIN_MFA_REQUIRED (ADR 66): o painel só abre para admin com a verificação em duas etapas. Ligar
 * a exigência sem a FIELD_ENCRYPTION_KEY trancaria o painel (sem a chave, ninguém ativa a 2FA):
 * a API não sobe, e diz por quê.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

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

const KEY = Buffer.alloc(32, 0x6d).toString('base64');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ADMIN_MFA_REQUIRED na subida (ADR 66)', () => {
  it('padrão: desligada', async () => {
    vi.stubEnv('ADMIN_MFA_REQUIRED', undefined);
    expect((await loadEnv()).ADMIN_MFA_REQUIRED).toBe(false);
  });

  it("'false' desliga; 'true' com a chave de cifragem liga", async () => {
    vi.stubEnv('ADMIN_MFA_REQUIRED', 'false');
    expect((await loadEnv()).ADMIN_MFA_REQUIRED).toBe(false);

    vi.stubEnv('ADMIN_MFA_REQUIRED', 'true');
    vi.stubEnv('FIELD_ENCRYPTION_KEY', KEY);
    expect((await loadEnv()).ADMIN_MFA_REQUIRED).toBe(true);
  });

  it('true sem a FIELD_ENCRYPTION_KEY não sobe, com o motivo no campo', async () => {
    vi.stubEnv('ADMIN_MFA_REQUIRED', 'true');
    vi.stubEnv('FIELD_ENCRYPTION_KEY', undefined);

    expect(await refused()).toEqual({
      ADMIN_MFA_REQUIRED: [
        'ADMIN_MFA_REQUIRED=true exige FIELD_ENCRYPTION_KEY (32 bytes em base64 (gere com "openssl rand -base64 32")): sem ela a verificação em duas etapas fica indisponível e nenhum admin entraria no painel',
      ],
    });
  });

  it('valor que não é true/false não sobe', async () => {
    vi.stubEnv('ADMIN_MFA_REQUIRED', 'sim');
    expect(Object.keys((await refused()) as object)).toEqual(['ADMIN_MFA_REQUIRED']);
  });
});
