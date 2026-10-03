import type { ErrorEvent, EventHint } from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
const captureException = vi.fn();
const flush = vi.fn().mockResolvedValue(true);
vi.mock('@sentry/node', () => ({ init, captureException, flush }));

describe('sentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sem SENTRY_DSN não inicia, não envia e não espera nada', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    const s = await import('./sentry');
    await s.initSentry();
    s.captureError(new Error('x'));
    await s.flushSentry();
    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('com SENTRY_DSN inicia uma vez, sem dado pessoal, e envia o erro', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://chave@o0.ingest.sentry.io/1');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'homologacao');
    const s = await import('./sentry');
    await s.initSentry();
    await s.initSentry();
    expect(init).toHaveBeenCalledTimes(1);
    const opts = init.mock.lastCall?.[0];
    expect(opts.environment).toBe('homologacao');
    expect(opts.release).toMatch(/^escambo-api@\d+\.\d+\.\d+\+/);
    // toEqual, e não toMatchObject: apagar uma linha devolveria o padrão do SDK, que é coletar.
    expect(opts.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
    expect(opts.maxBreadcrumbs).toBe(0);
    expect(opts.beforeSend).toBe(s.scrubEvent);
    // Definir a amostragem, mesmo em zero, liga as integrações de tracing.
    expect(opts).not.toHaveProperty('tracesSampleRate');

    const err = new Error('falhou');
    s.captureError(err);
    expect(captureException).toHaveBeenCalledWith(err);
    await s.flushSentry(500);
    expect(flush).toHaveBeenCalledWith(500);
  });
});

describe('scrubEvent', () => {
  const event = (value: string): ErrorEvent =>
    ({
      type: undefined,
      server_name: 'vps-escambo',
      exception: { values: [{ type: 'Error', value }] },
    }) as ErrorEvent;
  const hint = (originalException: unknown): EventHint => ({ originalException });

  it('erro do banco: vai só o código, nunca a mensagem com o valor que violou a regra', async () => {
    const { scrubEvent } = await import('./sentry');
    const dup = Object.assign(
      new Error("Duplicate entry 'fulano@email.com' for key 'users.email'"),
      {
        code: 'ER_DUP_ENTRY',
        sqlMessage: "Duplicate entry 'fulano@email.com' for key 'users.email'",
      },
    );
    const out = scrubEvent(event(dup.message), hint(dup));
    expect(out.exception?.values?.[0]?.value).toBe('ER_DUP_ENTRY');
    expect(JSON.stringify(out)).not.toContain('fulano');
  });

  it('e-mail em qualquer outra mensagem vira [email], e o nome da máquina não vai', async () => {
    const { scrubEvent } = await import('./sentry');
    const err = new Error('Falha ao enviar para maria.silva@exemplo.com.br: caixa cheia');
    const out = scrubEvent(event(err.message), hint(err));
    expect(out.exception?.values?.[0]?.value).toBe('Falha ao enviar para [email]: caixa cheia');
    expect(out).not.toHaveProperty('server_name');
  });

  it('mensagem sem dado pessoal passa inteira', async () => {
    const { scrubEvent } = await import('./sentry');
    const out = scrubEvent(event('Cannot read properties of undefined'), hint(new Error('x')));
    expect(out.exception?.values?.[0]?.value).toBe('Cannot read properties of undefined');
  });
});
