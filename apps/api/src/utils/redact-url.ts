/**
 * O log de cada requisição (pino-http) leva o endereço com a query e os cabeçalhos da resposta. No
 * login com Google (RF-002), a volta traz na query o código de autorização e o `state`, e as
 * respostas levam no Location o código de uso único do web (#codigo=), o `state` e o `nonce` da ida,
 * e no Set-Cookie o estado cifrado da ida. São valores de uso único, mas que não têm por que ficar
 * no log: aqui saem censurados; o resto passa igual.
 */

const GOOGLE_PATH = '/api/auth/google/';
const SECRET_PARAMS = ['code', 'state'];
const REDACTED = '[REDACTED]';
const PARAM_VALUE = new RegExp(`([?&](?:${SECRET_PARAMS.join('|')})=)[^&#]*`, 'g');
/** No endereço de redirecionamento: os da ida ao Google e o código de uso único do web. */
const LOCATION_VALUE = /([?&#](?:code|state|nonce|code_challenge|codigo)=)[^&#]*/g;
const STATE_COOKIE_VALUE = /(escambo_google=)[^;]*/g;

const isGooglePath = (url: string): boolean => url.startsWith(GOOGLE_PATH);

/** O endereço com `code` e `state` censurados, se for uma rota do Google; senão, igual. */
export function redactOAuthUrl(url: string | undefined): string | undefined {
  if (!url || !isGooglePath(url)) return url;
  return url.replace(PARAM_VALUE, `$1${REDACTED}`);
}

/** A query lida pelo Express, com os mesmos campos censurados (uma cópia: a original não muda). */
export function redactOAuthQuery(url: string | undefined, query: unknown): unknown {
  if (!url || !isGooglePath(url) || !query || typeof query !== 'object') return query;
  const copy: Record<string, unknown> = { ...(query as Record<string, unknown>) };
  for (const key of SECRET_PARAMS) if (key in copy) copy[key] = REDACTED;
  return copy;
}

/**
 * Os cabeçalhos da resposta como o log os leva: o Location sem os valores do fluxo do Google e o
 * Set-Cookie sem o estado da ida. Sem nenhum dos dois, o mesmo objeto; com, uma cópia.
 */
export function redactOAuthHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const h = headers as Record<string, unknown>;
  const { location } = h;
  const cookie = h['set-cookie'];
  if (typeof location !== 'string' && cookie === undefined) return headers;
  const copy: Record<string, unknown> = { ...h };
  if (typeof location === 'string')
    copy.location = location.replace(LOCATION_VALUE, `$1${REDACTED}`);
  if (cookie !== undefined) {
    copy['set-cookie'] = (Array.isArray(cookie) ? cookie : [cookie]).map((c) =>
      String(c).replace(STATE_COOKIE_VALUE, `$1${REDACTED}`),
    );
  }
  return copy;
}

/**
 * Os serializadores do log de requisição (pino-http): recebem o pedido e a resposta já no formato
 * do pino (url, query, headers) e devolvem com os valores do fluxo do Google censurados.
 */
export const httpLogSerializers = {
  req<T extends { url?: string; query?: unknown }>(req: T): T {
    const url = req.url;
    req.query = redactOAuthQuery(url, req.query);
    req.url = redactOAuthUrl(url);
    return req;
  },
  res<T extends { headers?: unknown }>(res: T): T {
    res.headers = redactOAuthHeaders(res.headers);
    return res;
  },
};
