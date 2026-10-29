import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Cliente OAuth 2.0 / OpenID Connect do Google (RF-002), sem SDK: o fluxo de servidor com código
 * de autorização, PKCE (S256), `state` e `nonce`, escopos `openid email profile`.
 *
 * O ID token chega direto do token endpoint, numa requisição da API ao Google por TLS, e não pelo
 * navegador. Por isso a assinatura não é conferida (OpenID Connect Core 3.1.3.7, item 6: o TLS
 * valida quem emitiu); o resto é: emissor, público (o nosso client id), validade, emissão recente,
 * o `nonce` desta ida e o e-mail confirmado pelo Google.
 *
 * Nada daqui chama a rede nos testes: o `fetch` é trocável (setGoogleFetchForTests), e os testes
 * ponta a ponta apontam GOOGLE_TEST_IDP_URL para um Google falso na própria máquina.
 */

export const GOOGLE_SCOPES = 'openid email profile';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Os dois emissores que o Google usa no `iss` (OpenID Connect do Google). */
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
/** Folga de relógio entre a API e o Google nas datas do ID token. */
export const ID_TOKEN_CLOCK_SKEW_SECONDS = 300;
/** Emitido há mais que isto, não vale: o ID token acabou de sair do token endpoint. */
export const ID_TOKEN_MAX_AGE_SECONDS = 600;
const TOKEN_TIMEOUT_MS = 10_000;

/** Por que o Google não deu um login válido (vai para o log e para a auditoria, sem dado pessoal). */
export type GoogleFailure =
  'token_exchange' | 'invalid_id_token' | 'nonce_mismatch' | 'email_not_verified';

export class GoogleAuthError extends Error {
  constructor(public readonly reason: GoogleFailure) {
    super(`login com Google recusado: ${reason}`);
    this.name = 'GoogleAuthError';
  }
}

/** Quem o Google diz que é a pessoa: o `sub` (estável), o e-mail confirmado e o nome, se veio. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

/** Ligado só com o client id e o segredo (o env não sobe com um sem o outro). */
export function googleEnabled(): boolean {
  return env.GOOGLE_CLIENT_ID !== '' && env.GOOGLE_CLIENT_SECRET !== '';
}

/** O endereço de volta: GOOGLE_REDIRECT_URI, ou o da API no domínio do app (APP_URL). */
export function googleRedirectUri(): string {
  return env.GOOGLE_REDIRECT_URI || `${env.APP_URL.replace(/\/+$/, '')}/api/auth/google/callback`;
}

/** Os endereços do Google, ou os do Google falso dos testes (só na própria máquina, ver env). */
function endpoints(): { auth: string; token: string } {
  const testIdp = env.GOOGLE_TEST_IDP_URL.replace(/\/+$/, '');
  return testIdp
    ? { auth: `${testIdp}/authorize`, token: `${testIdp}/token` }
    : { auth: GOOGLE_AUTH_URL, token: GOOGLE_TOKEN_URL };
}

const realFetch: typeof fetch = (input, init) => fetch(input, init);
let fetchImpl: typeof fetch = realFetch;

/** Só para testes: o `fetch` do token endpoint (null volta ao de verdade). */
export function setGoogleFetchForTests(impl: typeof fetch | null): void {
  fetchImpl = impl ?? realFetch;
}

/** 32 bytes aleatórios em base64url (43 caracteres): serve de state, nonce e code_verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE S256 (RFC 7636): o desafio é o SHA-256 do verificador, em base64url. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Compara dois textos sem vazar pelo tempo onde eles diferem. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** O endereço da tela do Google para onde o navegador vai (o start redireciona para ele). */
export function authorizationUrl(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
}): string {
  const url = new URL(endpoints().auth);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state: input.state,
    nonce: input.nonce,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: 'S256',
    // Quem tem mais de uma conta Google escolhe com qual entra, em vez de cair na última usada.
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

function decodeSegment(segment: string | undefined): Record<string, unknown> | null {
  if (!segment) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** O `sub` do Google: texto ASCII visível, de 1 a 255 caracteres (a coluna é ascii_bin). */
const SUB_PATTERN = /^[\x21-\x7e]{1,255}$/;
/** Um e-mail com a forma mínima (o Google já o confirmou; aqui só não deixa lixo entrar). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Confere o ID token que veio do token endpoint e devolve a identidade. Não confere a assinatura
 * (ver o topo do arquivo); confere o resto, e e-mail sem `email_verified === true` não entra.
 */
export function validateIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; nowMs: number },
): GoogleIdentity {
  const parts = idToken.split('.');
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (parts.length !== 3 || !header || !claims) throw new GoogleAuthError('invalid_id_token');
  if (typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') {
    throw new GoogleAuthError('invalid_id_token');
  }

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new GoogleAuthError('invalid_id_token');
  }
  // Público: o nosso client id. Com mais de um público, o `azp` diz para quem o token saiu.
  const aud = claims.aud;
  const audOk =
    aud === expected.clientId ||
    (Array.isArray(aud) && aud.includes(expected.clientId) && claims.azp === expected.clientId);
  if (!audOk || (claims.azp !== undefined && claims.azp !== expected.clientId)) {
    throw new GoogleAuthError('invalid_id_token');
  }
  const now = expected.nowMs / 1000;
  const { exp, iat } = claims;
  if (typeof exp !== 'number' || exp + ID_TOKEN_CLOCK_SKEW_SECONDS <= now) {
    throw new GoogleAuthError('invalid_id_token');
  }
  if (
    typeof iat !== 'number' ||
    iat > now + ID_TOKEN_CLOCK_SKEW_SECONDS ||
    iat < now - ID_TOKEN_MAX_AGE_SECONDS - ID_TOKEN_CLOCK_SKEW_SECONDS
  ) {
    throw new GoogleAuthError('invalid_id_token');
  }
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expected.nonce)) {
    throw new GoogleAuthError('nonce_mismatch');
  }
  if (typeof claims.sub !== 'string' || !SUB_PATTERN.test(claims.sub)) {
    throw new GoogleAuthError('invalid_id_token');
  }
  if (
    typeof claims.email !== 'string' ||
    claims.email.length > 255 ||
    !EMAIL_PATTERN.test(claims.email)
  ) {
    throw new GoogleAuthError('invalid_id_token');
  }
  if (claims.email_verified !== true) throw new GoogleAuthError('email_not_verified');

  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 150) : '';
  return { sub: claims.sub, email: claims.email, name: name === '' ? null : name };
}

/**
 * Troca o código pelo ID token no token endpoint (com o verificador do PKCE e o segredo do
 * cliente) e confere o token. Do Google, só o ID token é lido: o access token não é usado nem
 * guardado. O log leva só o status e o código de erro do Google, nunca o corpo nem os tokens.
 */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  nonce: string;
}): Promise<GoogleIdentity> {
  let res: Response;
  try {
    res = await fetchImpl(endpoints().token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    logger.warn(
      { error: e.name ?? 'Error', cause: e.cause?.code },
      'login com Google: o token endpoint não respondeu',
    );
    throw new GoogleAuthError('token_exchange');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    logger.warn(
      { status: res.status, error: typeof body?.error === 'string' ? body.error : undefined },
      'login com Google: o token endpoint recusou o código',
    );
    throw new GoogleAuthError('token_exchange');
  }
  if (typeof body?.id_token !== 'string') throw new GoogleAuthError('invalid_id_token');
  return validateIdToken(body.id_token, {
    clientId: env.GOOGLE_CLIENT_ID,
    nonce: input.nonce,
    nowMs: Date.now(),
  });
}

/** Na subida: se o login com Google está ligado, e o aviso do Google falso dos testes. */
export function logGoogleLoginStatus(): void {
  if (!googleEnabled()) {
    logger.info('Login com Google desligado (sem GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET)');
    return;
  }
  logger.info({ redirectUri: googleRedirectUri() }, 'Login com Google ligado');
  if (env.GOOGLE_TEST_IDP_URL) {
    logger.warn(
      { idp: env.GOOGLE_TEST_IDP_URL },
      'Login com Google apontando para o Google FALSO dos testes (GOOGLE_TEST_IDP_URL): deixe vazio fora dos testes',
    );
  }
}
