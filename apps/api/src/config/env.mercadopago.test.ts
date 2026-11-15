import { afterEach, describe, expect, it, vi } from 'vitest';

// Hermético: o .env local de quem roda não pode trazer de volta o que o teste apaga.
vi.mock('dotenv/config', () => ({}));

/**
 * Mercado Pago na subida (ADR 73): o gateway simulado é o padrão; o Mercado Pago sem o token ou
 * sem a chave secreta do webhook não sobe; e o endereço da API precisa ser https (o token vai no
 * cabeçalho), salvo na própria máquina, nos testes.
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

const TOKEN = 'APP_USR-0000000000000000-000000-teste';
const SECRET = 'chave-secreta-do-webhook-de-teste';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('variáveis do Mercado Pago', () => {
  it('padrão: gateway simulado, sandbox, API oficial e 72 horas de validade', async () => {
    for (const key of [
      'PAYMENT_GATEWAY',
      'MERCADOPAGO_ACCESS_TOKEN',
      'MERCADOPAGO_WEBHOOK_SECRET',
      'MERCADOPAGO_SANDBOX',
      'MERCADOPAGO_API_URL',
      'MERCADOPAGO_DEPOSIT_EXPIRES_HOURS',
    ]) {
      vi.stubEnv(key, undefined);
    }
    const env = await loadEnv();
    expect(env.PAYMENT_GATEWAY).toBe('simulated');
    expect(env.MERCADOPAGO_ACCESS_TOKEN).toBe('');
    expect(env.MERCADOPAGO_SANDBOX).toBe(true);
    expect(env.MERCADOPAGO_API_URL).toBe('https://api.mercadopago.com');
    expect(env.MERCADOPAGO_DEPOSIT_EXPIRES_HOURS).toBe(72);
  });

  it('mercadopago com o token e a chave sobe, aparando espaços', async () => {
    vi.stubEnv('PAYMENT_GATEWAY', 'mercadopago');
    vi.stubEnv('MERCADOPAGO_ACCESS_TOKEN', ` ${TOKEN} `);
    vi.stubEnv('MERCADOPAGO_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('MERCADOPAGO_SANDBOX', 'false');
    const env = await loadEnv();
    expect(env.PAYMENT_GATEWAY).toBe('mercadopago');
    expect(env.MERCADOPAGO_ACCESS_TOKEN).toBe(TOKEN);
    expect(env.MERCADOPAGO_SANDBOX).toBe(false);
  });

  it('mercadopago sem o token ou sem a chave secreta não sobe, e diz qual falta sem mostrar o outro', async () => {
    vi.stubEnv('PAYMENT_GATEWAY', 'mercadopago');
    vi.stubEnv('MERCADOPAGO_ACCESS_TOKEN', TOKEN);
    vi.stubEnv('MERCADOPAGO_WEBHOOK_SECRET', '');
    const a = await refused();
    expect(a.MERCADOPAGO_WEBHOOK_SECRET?.[0]).toContain('PAYMENT_GATEWAY=mercadopago exige');
    expect(JSON.stringify(a)).not.toContain(TOKEN);

    vi.restoreAllMocks();
    vi.stubEnv('MERCADOPAGO_ACCESS_TOKEN', '');
    vi.stubEnv('MERCADOPAGO_WEBHOOK_SECRET', SECRET);
    const b = await refused();
    expect(b.MERCADOPAGO_ACCESS_TOKEN?.[0]).toContain('MERCADOPAGO_ACCESS_TOKEN');
    expect(JSON.stringify(b)).not.toContain(SECRET);
  });

  it('com o simulado, as credenciais do Mercado Pago podem faltar', async () => {
    vi.stubEnv('PAYMENT_GATEWAY', 'simulated');
    vi.stubEnv('MERCADOPAGO_ACCESS_TOKEN', '');
    vi.stubEnv('MERCADOPAGO_WEBHOOK_SECRET', '');
    expect((await loadEnv()).PAYMENT_GATEWAY).toBe('simulated');
  });

  it('gateway desconhecido não sobe', async () => {
    vi.stubEnv('PAYMENT_GATEWAY', 'pagarme');
    expect((await refused()).PAYMENT_GATEWAY).toBeDefined();
  });

  it('a API só por https, ou na própria máquina', async () => {
    vi.stubEnv('MERCADOPAGO_API_URL', 'http://127.0.0.1:4011');
    expect((await loadEnv()).MERCADOPAGO_API_URL).toBe('http://127.0.0.1:4011');
    for (const bad of ['http://api.mercadopago.com', 'https://u:p@api.mercadopago.com', 'nada']) {
      vi.restoreAllMocks();
      vi.stubEnv('MERCADOPAGO_API_URL', bad);
      expect((await refused()).MERCADOPAGO_API_URL?.[0]).toContain('https');
    }
  });

  it('validade do depósito: de 1 hora a 30 dias', async () => {
    for (const bad of ['0', '721', 'x']) {
      vi.restoreAllMocks();
      vi.stubEnv('MERCADOPAGO_DEPOSIT_EXPIRES_HOURS', bad);
      expect((await refused()).MERCADOPAGO_DEPOSIT_EXPIRES_HOURS).toBeDefined();
    }
  });
});
