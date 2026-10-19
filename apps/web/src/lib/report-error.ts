import { ApiRequestError } from './api';

/**
 * Relato de erro do navegador para a API (RNF-040), que registra, conta na métrica e repassa ao
 * Sentry. Nunca atrapalha a tela: não lança, não espera a resposta e para depois de 5 relatos
 * por página aberta (uma tela quebrada em laço não vira uma enxurrada). O mesmo erro vai uma vez.
 */
export type ClientErrorKind = 'render' | 'error' | 'rejection';

const MAX_REPORTS = 5;
let sent = 0;
const seen = new Set<string>();

/** Zera o limite e a memória de repetidos (testes). */
export function resetErrorReporting(): void {
  sent = 0;
  seen.clear();
}

/**
 * Erro que não vale relatar: a recusa da API (ela mesma já registrou), o erro de rede (é a
 * conexão de quem usa, não um defeito) e o aviso do ResizeObserver, que o navegador solta à toa.
 */
function ignorable(error: unknown): boolean {
  if (error instanceof ApiRequestError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ResizeObserver loop|Failed to fetch|NetworkError|Load failed/i.test(message);
}

export function reportClientError(
  kind: ClientErrorKind,
  error: unknown,
  componentStack?: string | null,
): void {
  try {
    if (sent >= MAX_REPORTS || ignorable(error)) return;
    const err = error instanceof Error ? error : new Error(String(error));
    const message = (err.message || err.name || 'Erro sem mensagem').slice(0, 500);
    const key = `${kind}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    const body = JSON.stringify({
      kind,
      message,
      ...(err.stack ? { stack: err.stack.slice(0, 4000) } : {}),
      ...(componentStack ? { componentStack: componentStack.slice(0, 4000) } : {}),
      // Só o caminho: a query de /redefinir-senha leva o token.
      path: window.location.pathname.slice(0, 300),
    });
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* relatar nunca quebra a tela */
  }
}

/**
 * Ouve o que escapa do React: erro de script (só os do próprio app; o de extensão ou de outro
 * domínio chega como "Script error." sem arquivo, e fica de fora) e promessa rejeitada sem catch.
 * Devolve a função que para de ouvir.
 */
export function installErrorReporting(): () => void {
  const onError = (event: ErrorEvent): void => {
    if (!event.filename || !event.filename.startsWith(window.location.origin)) return;
    reportClientError('error', event.error ?? new Error(event.message));
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportClientError('rejection', event.reason);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
