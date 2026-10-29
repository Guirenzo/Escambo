import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  authorizationUrl,
  exchangeCode,
  GoogleAuthError,
  googleEnabled,
  googleRedirectUri,
  ID_TOKEN_MAX_AGE_SECONDS,
  logGoogleLoginStatus,
  pkceChallenge,
  randomToken,
  safeEqual,
  setGoogleFetchForTests,
  validateIdToken,
} from './google-oauth';

/**
 * O cliente OAuth do Google (RF-002) sem rede: o endereço da ida (PKCE S256, state, nonce, escopos),
 * a troca do código com o `fetch` trocado e cada conferência do ID token. O token aqui não tem
 * assinatura de verdade, como o que o Google manda pelo TLS também não é conferido (OIDC Core
 * 3.1.3.7, item 6).
 */

const CLIENT_ID = 'cliente-de-teste.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const NONCE = 'nonce-da-ida-0123456789';
const log = vi.mocked(logger);

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: 'RS256', kid: 'chave-1' },
): string =>
  `${b64(header)}.${b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '109876543210987654321',
    email: 'ana@gmail.com',
    email_verified: true,
    name: 'Ana Souza',
    nonce: NONCE,
    iat: NOW / 1000 - 5,
    exp: NOW / 1000 + 3600,
    ...claims,
  })}.assinatura-que-nao-e-conferida`;

const check = (token: string) =>
  validateIdToken(token, { clientId: CLIENT_ID, nonce: NONCE, nowMs: NOW });
const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof GoogleAuthError ? err.reason : `outro: ${String(err)}`;
  }
  return undefined;
};

const saved = { ...env };
beforeEach(() => {
  env.GOOGLE_CLIENT_ID = CLIENT_ID;
  env.GOOGLE_CLIENT_SECRET = 'segredo-de-teste-do-google-com-32-caracteres';
  env.GOOGLE_REDIRECT_URI = '';
  env.GOOGLE_TEST_IDP_URL = '';
  env.APP_URL = 'https://escambo.example/';
  vi.clearAllMocks();
});
afterEach(() => {
  Object.assign(env, saved);
  setGoogleFetchForTests(null);
});

describe('configuração', () => {
  it('ligado só com o client id e o segredo', () => {
    expect(googleEnabled()).toBe(true);
    env.GOOGLE_CLIENT_SECRET = '';
    expect(googleEnabled()).toBe(false);
    env.GOOGLE_CLIENT_SECRET = 'x';
    env.GOOGLE_CLIENT_ID = '';
    expect(googleEnabled()).toBe(false);
  });

  it('o endereço de volta: o configurado, ou o da API no domínio do app (sem barra dobrada)', () => {
    expect(googleRedirectUri()).toBe('https://escambo.example/api/auth/google/callback');
    env.GOOGLE_REDIRECT_URI = 'http://localhost:3333/api/auth/google/callback';
    expect(googleRedirectUri()).toBe('http://localhost:3333/api/auth/google/callback');
  });

  it('a subida diz se está ligado, e avisa do Google falso dos testes', () => {
    logGoogleLoginStatus();
    expect(log.info).toHaveBeenCalledWith(
      { redirectUri: 'https://escambo.example/api/auth/google/callback' },
      'Login com Google ligado',
    );
    expect(log.warn).not.toHaveBeenCalled();

    env.GOOGLE_TEST_IDP_URL = 'http://127.0.0.1:4010';
    logGoogleLoginStatus();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![1])).toContain('Google FALSO');

    vi.clearAllMocks();
    env.GOOGLE_CLIENT_ID = '';
    env.GOOGLE_CLIENT_SECRET = '';
    logGoogleLoginStatus();
    expect(log.info.mock.calls[0]![0]).toContain('desligado');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('a ida ao Google', () => {
  it('PKCE S256, state, nonce, escopos openid email profile e o endereço de volta', () => {
    const verifier = randomToken();
    const url = new URL(authorizationUrl({ state: 'st', nonce: 'nn', codeVerifier: verifier }));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'https://escambo.example/api/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      state: 'st',
      nonce: 'nn',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    // O verificador nunca vai no endereço.
    expect(url.toString()).not.toContain(verifier);
  });

  it('o desafio do PKCE é o do RFC 7636 (exemplo do apêndice B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('cada valor aleatório tem 43 caracteres base64url e não se repete', () => {
    const values = new Set(Array.from({ length: 20 }, () => randomToken()));
    expect(values.size).toBe(20);
    for (const v of values) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('com o Google falso dos testes, a ida e a troca vão para ele', async () => {
    env.GOOGLE_TEST_IDP_URL = 'http://127.0.0.1:4010/';
    expect(authorizationUrl({ state: 's', nonce: 'n', codeVerifier: 'v' })).toMatch(
      /^http:\/\/127\.0\.0\.1:4010\/authorize\?/,
    );
    const fetchMock = vi.fn(async () => Response.json({ id_token: idToken() }));
    setGoogleFetchForTests(fetchMock as unknown as typeof fetch);
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      await exchangeCode({ code: 'c', codeVerifier: 'v', nonce: NONCE });
    } finally {
      vi.useRealTimers();
    }
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('http://127.0.0.1:4010/token');
  });

  it('safeEqual compara o texto inteiro, de qualquer tamanho', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('a troca do código', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('POST com o verificador, o segredo e o endereço de volta; devolve a identidade', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: 'ya29.nao-usado', id_token: idToken(), expires_in: 3599 }),
    );
    setGoogleFetchForTests(fetchMock as unknown as typeof fetch);

    const out = await exchangeCode({ code: 'codigo-1', codeVerifier: 'verif', nonce: NONCE });

    expect(out).toEqual({
      sub: '109876543210987654321',
      email: 'ana@gmail.com',
      name: 'Ana Souza',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'codigo-1',
      code_verifier: 'verif',
      client_id: CLIENT_ID,
      client_secret: 'segredo-de-teste-do-google-com-32-caracteres',
      redirect_uri: 'https://escambo.example/api/auth/google/callback',
    });
  });

  it('o Google recusou o código: token_exchange, e o log só leva o status e o código do erro', async () => {
    setGoogleFetchForTests((async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'Bad Request' },
        { status: 400 },
      )) as unknown as typeof fetch);
    await expect(
      exchangeCode({ code: 'c', codeVerifier: 'v', nonce: NONCE }),
    ).rejects.toMatchObject({
      reason: 'token_exchange',
    });
    expect(log.warn).toHaveBeenCalledWith(
      { status: 400, error: 'invalid_grant' },
      'login com Google: o token endpoint recusou o código',
    );
  });

  it('resposta sem JSON, ou erro sem código: token_exchange, sem quebrar', async () => {
    setGoogleFetchForTests(
      (async () => new Response('<html>erro</html>', { status: 502 })) as unknown as typeof fetch,
    );
    await expect(
      exchangeCode({ code: 'c', codeVerifier: 'v', nonce: NONCE }),
    ).rejects.toMatchObject({
      reason: 'token_exchange',
    });
    expect(log.warn.mock.calls[0]![0]).toEqual({ status: 502, error: undefined });
  });

  it('o Google fora do ar (rede, tempo): token_exchange, com o nome e a causa do erro no log', async () => {
    setGoogleFetchForTests((async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch);
    await expect(
      exchangeCode({ code: 'c', codeVerifier: 'v', nonce: NONCE }),
    ).rejects.toMatchObject({
      reason: 'token_exchange',
    });
    expect(log.warn.mock.calls[0]![0]).toEqual({ error: 'TypeError', cause: 'ECONNREFUSED' });

    setGoogleFetchForTests((async () => {
      throw {};
    }) as unknown as typeof fetch);
    await expect(
      exchangeCode({ code: 'c', codeVerifier: 'v', nonce: NONCE }),
    ).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('200 sem id_token: invalid_id_token', async () => {
    setGoogleFetchForTests((async () =>
      Response.json({ access_token: 'x' })) as unknown as typeof fetch);
    await expect(
      exchangeCode({ code: 'c', codeVerifier: 'v', nonce: NONCE }),
    ).rejects.toMatchObject({
      reason: 'invalid_id_token',
    });
  });
});

describe('o ID token', () => {
  it('válido: sub, e-mail e nome (aparado e cortado em 150; vazio vira null)', () => {
    expect(check(idToken())).toEqual({
      sub: '109876543210987654321',
      email: 'ana@gmail.com',
      name: 'Ana Souza',
    });
    expect(check(idToken({ name: '   ' })).name).toBeNull();
    expect(check(idToken({ name: undefined })).name).toBeNull();
    expect(check(idToken({ name: `  ${'a'.repeat(200)} ` })).name).toHaveLength(150);
  });

  it('os dois emissores do Google valem; outro não', () => {
    expect(check(idToken({ iss: 'accounts.google.com' })).sub).toBeTruthy();
    expect(reasonOf(() => check(idToken({ iss: 'https://evil.example' })))).toBe(
      'invalid_id_token',
    );
    expect(reasonOf(() => check(idToken({ iss: undefined })))).toBe('invalid_id_token');
  });

  it('o público tem de ser o nosso client id (com mais de um, o azp diz para quem saiu)', () => {
    expect(reasonOf(() => check(idToken({ aud: 'outro-cliente' })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ azp: 'outro-cliente' })))).toBe('invalid_id_token');
    expect(check(idToken({ aud: [CLIENT_ID, 'outro'], azp: CLIENT_ID })).sub).toBeTruthy();
    expect(reasonOf(() => check(idToken({ aud: [CLIENT_ID, 'outro'], azp: undefined })))).toBe(
      'invalid_id_token',
    );
    expect(check(idToken({ azp: undefined })).sub).toBeTruthy();
  });

  it('vencido não vale (com 5 minutos de folga de relógio)', () => {
    expect(reasonOf(() => check(idToken({ exp: NOW / 1000 - 301 })))).toBe('invalid_id_token');
    expect(check(idToken({ exp: NOW / 1000 - 299 })).sub).toBeTruthy();
    expect(reasonOf(() => check(idToken({ exp: '9999999999' })))).toBe('invalid_id_token');
  });

  it('emitido no futuro ou há muito tempo não vale: o token acabou de sair do Google', () => {
    expect(reasonOf(() => check(idToken({ iat: NOW / 1000 + 301 })))).toBe('invalid_id_token');
    const old = NOW / 1000 - ID_TOKEN_MAX_AGE_SECONDS - 301;
    expect(reasonOf(() => check(idToken({ iat: old })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ iat: undefined })))).toBe('invalid_id_token');
  });

  it('o nonce tem de ser o desta ida', () => {
    expect(reasonOf(() => check(idToken({ nonce: 'outro-nonce' })))).toBe('nonce_mismatch');
    expect(reasonOf(() => check(idToken({ nonce: undefined })))).toBe('nonce_mismatch');
  });

  it('e-mail que o Google não confirmou não entra (só true vale, nem "true")', () => {
    expect(reasonOf(() => check(idToken({ email_verified: false })))).toBe('email_not_verified');
    expect(reasonOf(() => check(idToken({ email_verified: 'true' })))).toBe('email_not_verified');
    expect(reasonOf(() => check(idToken({ email_verified: undefined })))).toBe(
      'email_not_verified',
    );
  });

  it('sub e e-mail com forma estranha não entram', () => {
    expect(reasonOf(() => check(idToken({ sub: '' })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ sub: 'com espaço' })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ sub: 'x'.repeat(256) })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ sub: 123 })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ email: 'sem-arroba' })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({ email: `${'a'.repeat(250)}@x.com` })))).toBe(
      'invalid_id_token',
    );
  });

  it('token malformado ou sem algoritmo ("none") não entra', () => {
    expect(reasonOf(() => check('sem-pontos'))).toBe('invalid_id_token');
    expect(reasonOf(() => check('a.b'))).toBe('invalid_id_token');
    expect(reasonOf(() => check(`${idToken()}.extra`))).toBe('invalid_id_token');
    expect(reasonOf(() => check(`x.${b64({})}.y`))).toBe('invalid_id_token');
    expect(reasonOf(() => check(`${b64([1])}.${b64({})}.y`))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({}, { alg: 'none' })))).toBe('invalid_id_token');
    expect(reasonOf(() => check(idToken({}, { typ: 'JWT' })))).toBe('invalid_id_token');
  });
});
