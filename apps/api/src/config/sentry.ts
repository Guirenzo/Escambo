import type { ErrorEvent, EventHint } from '@sentry/node';
import { buildInfo } from './build-info';
import { env } from './env';

/**
 * Rastreamento de erros (ADR 59). Sem SENTRY_DSN o pacote nem é carregado e nada sai da máquina.
 * Só vão ao Sentry as falhas do servidor: os erros que viram 500, as falhas de job e as que
 * derrubam o processo. Nenhum dado da pessoa vai junto (LGPD, como o redact do log): sem usuário,
 * cookies, cabeçalhos, corpos, query string, SQL, variáveis locais da pilha nem o rastro das
 * chamadas anteriores — só o tipo, a mensagem (sem e-mail e sem o texto do banco) e a pilha.
 */
type SentryModule = typeof import('@sentry/node');
let sentry: SentryModule | null = null;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Última barreira antes do envio. A mensagem de erro do MySQL repete o valor que violou a regra
 * ("Duplicate entry 'fulano@x.com' for key…"): vai só o código. Qualquer outro e-mail no texto
 * vira "[email]", e o nome da máquina não vai.
 */
export function scrubEvent(event: ErrorEvent, hint: EventHint): ErrorEvent {
  const original = hint.originalException as { code?: unknown; sqlMessage?: unknown } | null;
  const dbCode =
    original != null && typeof original.sqlMessage === 'string' && typeof original.code === 'string'
      ? original.code
      : null;
  for (const ex of event.exception?.values ?? []) {
    if (dbCode) ex.value = dbCode;
    else if (ex.value) ex.value = ex.value.replace(EMAIL, '[email]');
  }
  delete event.server_name;
  return event;
}

export async function initSentry(): Promise<void> {
  if (!env.SENTRY_DSN || sentry) return;
  const mod = await import('@sentry/node');
  mod.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: `escambo-api@${buildInfo.version}+${buildInfo.commit}`,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    // O rastro guardaria a URL de cada chamada de saída, e a do push identifica o aparelho.
    maxBreadcrumbs: 0,
    beforeSend: scrubEvent,
  });
  sentry = mod;
}

export function captureError(err: unknown): void {
  sentry?.captureException(err);
}

/** Espera o envio do que está na fila (encerramento do processo). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  await sentry?.flush(timeoutMs);
}
