import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env';
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_STATE_TTL_SECONDS,
  googleReturnCookieOptions,
  googleReturnMatches,
  googleStateClearOptions,
  googleStateCookieOptions,
  openGoogleState,
  readCookie,
  sealGoogleReturn,
  sealGoogleState,
} from './google-state';

/**
 * O cookie da ida ao Google (RF-002): cifrado e autenticado pela API, vale 10 minutos, e o
 * navegador não lê nem altera nada (o verificador do PKCE e o nonce não ficam à vista).
 */

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const payload = { state: 'state-1', nonce: 'nonce-1', verifier: 'verificador-1', issuedAt: NOW };
const saved = { ...env };
afterEach(() => Object.assign(env, saved));

describe('cifra do estado da ida', () => {
  it('fecha e abre o mesmo estado; o valor não mostra nada do que guarda', () => {
    const sealed = sealGoogleState(payload);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const part of ['state-1', 'nonce-1', 'verificador-1']) expect(sealed).not.toContain(part);
    expect(openGoogleState(sealed, NOW + 1000)).toEqual(payload);
    // IV aleatório: o mesmo estado nunca sai igual duas vezes.
    expect(sealGoogleState(payload)).not.toBe(sealed);
  });

  it('vale 10 minutos; do futuro (relógio voltou mais de 1 minuto) também não', () => {
    const sealed = sealGoogleState(payload);
    expect(openGoogleState(sealed, NOW + GOOGLE_STATE_TTL_SECONDS * 1000)).not.toBeNull();
    expect(openGoogleState(sealed, NOW + GOOGLE_STATE_TTL_SECONDS * 1000 + 1)).toBeNull();
    expect(openGoogleState(sealed, NOW - 61_000)).toBeNull();
  });

  it('adulterado, truncado, de outra chave (JWT_SECRET trocado) ou lixo: null', () => {
    const sealed = sealGoogleState(payload);
    const raw = Buffer.from(sealed, 'base64url');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01;
    expect(openGoogleState(raw.toString('base64url'), NOW)).toBeNull();
    expect(openGoogleState(sealed.slice(0, 20), NOW)).toBeNull();
    expect(openGoogleState('x'.repeat(4000), NOW)).toBeNull();
    expect(openGoogleState('nada-a-ver', NOW)).toBeNull();

    env.JWT_SECRET = 'segredo-de-teste-trocado-com-mais-de-32-caracteres';
    expect(openGoogleState(sealed, NOW)).toBeNull();
  });

  it('conteúdo sem os campos certos não abre', () => {
    for (const bad of [
      { ...payload, state: '' },
      { ...payload, nonce: 5 },
      { ...payload, verifier: 'v'.repeat(129) },
      { ...payload, issuedAt: '2026' },
    ]) {
      expect(openGoogleState(sealGoogleState(bad as never), NOW)).toBeNull();
    }
  });
});

describe('cookie da volta (o código amarrado ao navegador)', () => {
  it('vale para o código que levou, por 2 minutos; outro código, outra chave ou o cookie da ida: não', () => {
    const sealed = sealGoogleReturn('codigo-1', NOW);
    expect(sealed).not.toContain('codigo-1');
    expect(googleReturnMatches(sealed, 'codigo-1', NOW + 120_000)).toBe(true);
    expect(googleReturnMatches(sealed, 'codigo-1', NOW + 120_001)).toBe(false);
    expect(googleReturnMatches(sealed, 'codigo-1', NOW - 61_000)).toBe(false);
    expect(googleReturnMatches(sealed, 'codigo-2', NOW)).toBe(false);
    expect(googleReturnMatches(null, 'codigo-1', NOW)).toBe(false);
    expect(googleReturnMatches('lixo', 'codigo-1', NOW)).toBe(false);
    // O cookie da ida não serve de cookie da volta (e vice-versa): o dado autenticado é outro.
    expect(googleReturnMatches(sealGoogleState(payload), 'codigo-1', NOW)).toBe(false);
    expect(openGoogleState(sealed, NOW)).toBeNull();
    env.JWT_SECRET = 'segredo-de-teste-trocado-com-mais-de-32-caracteres';
    expect(googleReturnMatches(sealed, 'codigo-1', NOW)).toBe(false);
  });

  it('opções: as mesmas marcas do cookie da ida, vivendo 2 minutos', () => {
    env.NODE_ENV = 'development';
    env.APP_URL = 'http://localhost:5173';
    env.GOOGLE_REDIRECT_URI = '';
    expect(googleReturnCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/api/auth/google',
      maxAge: 120_000,
    });
  });
});

describe('o cookie', () => {
  it('readCookie acha o cookie certo entre outros; ausente ou mal codificado: null', () => {
    expect(readCookie(`a=1; ${GOOGLE_STATE_COOKIE}=valor%2Dx; b=2`, GOOGLE_STATE_COOKIE)).toBe(
      'valor-x',
    );
    expect(readCookie('a=1; semigual; b=2', GOOGLE_STATE_COOKIE)).toBeNull();
    expect(readCookie(undefined, GOOGLE_STATE_COOKIE)).toBeNull();
    expect(readCookie(`${GOOGLE_STATE_COOKIE}=%E0%A4%A`, GOOGLE_STATE_COOKIE)).toBeNull();
    expect(readCookie(`x${GOOGLE_STATE_COOKIE}=1`, GOOGLE_STATE_COOKIE)).toBeNull();
  });

  it('httpOnly, SameSite=Lax, só no caminho do Google, 10 minutos; Secure fora do desenvolvimento', () => {
    env.NODE_ENV = 'development';
    env.APP_URL = 'http://localhost:5173';
    env.GOOGLE_REDIRECT_URI = '';
    expect(googleStateCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/api/auth/google',
      maxAge: 600_000,
    });
    expect(googleStateClearOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/api/auth/google',
    });
    // Volta por https: Secure, mesmo fora da produção.
    env.APP_URL = 'https://escambo.example';
    expect(googleStateCookieOptions().secure).toBe(true);
    // Produção: sempre Secure (o navegador aceita em http://localhost, como nos e2e do CI).
    env.APP_URL = 'http://localhost:5173';
    env.NODE_ENV = 'production';
    expect(googleStateCookieOptions().secure).toBe(true);
  });
});
