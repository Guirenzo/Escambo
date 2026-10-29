import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { env } from '../../config/env';
import { hashToken } from '../../utils/tokens';
import { googleRedirectUri, safeEqual } from './google-oauth';

/**
 * O que o login com Google (RF-002) guarda no próprio navegador, em dois cookies:
 *
 * - **A ida** (escambo_google): o `state`, o `nonce` e o verificador do PKCE, que a volta precisa.
 *   Fica num cookie, e não numa tabela: é o cookie que amarra a volta ao navegador que saiu (sem ele,
 *   alguém poderia mandar à vítima o endereço de volta de um login dele), não exige limpeza no banco,
 *   e o verificador nunca vai para o endereço nem para o log. Vale 10 minutos; a volta o apaga
 *   sempre, e o `state` usado fica registrado (google_login_tickets): a mesma volta não passa duas
 *   vezes.
 * - **A volta** (escambo_google_volta): o hash do código de uso único que a volta deixa no endereço
 *   do web. A troca (POST /auth/google/exchange) só aceita o código com este cookie: sem ele, quem
 *   tivesse um código do próprio login, sem trocar, poderia mandar à vítima o endereço
 *   /entrar/google#codigo=… e deixá-la entrando na conta dele (CSRF de login). Vale o tempo do código.
 *
 * Os dois são cifrados e autenticados pela API (AES-256-GCM, chave derivada do JWT_SECRET num
 * contexto próprio, como o passe da 2FA, e um dado autenticado por cookie): o navegador não lê nem
 * altera nada. httpOnly, SameSite=Lax (a volta do Google é uma navegação de primeiro nível, que o
 * Lax deixa levar o cookie), Secure fora do desenvolvimento e só no caminho do Google na API.
 */

export const GOOGLE_STATE_COOKIE = 'escambo_google';
export const GOOGLE_STATE_TTL_SECONDS = 600;
export const GOOGLE_RETURN_COOKIE = 'escambo_google_volta';
/** O código que a volta deixa no endereço do web: só o tempo de o web trocá-lo. */
export const GOOGLE_EXCHANGE_TTL_SECONDS = 120;
const COOKIE_PATH = '/api/auth/google';
/** Dado autenticado da cifra: um valor cifrado para um cookie não abre no outro. */
const STATE_AAD = Buffer.from('escambo:google-state:v1');
const RETURN_AAD = Buffer.from('escambo:google-return:v1');
/** Relógio da API que voltou um pouco: tolerado; mais que isto, o cookie não vale. */
const FUTURE_SKEW_MS = 60_000;

export interface GoogleStatePayload {
  state: string;
  nonce: string;
  verifier: string;
  /** Quando saiu (ms desde a época): vale GOOGLE_STATE_TTL_SECONDS. */
  issuedAt: number;
}

const cookieKey = (): Buffer =>
  createHmac('sha256', env.JWT_SECRET).update('escambo:google-state-key:').digest();

/** Cifra um valor: iv (12) + tag (16) + cifra, em base64url. */
function seal(aad: Buffer, payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(), iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

/** Abre um valor cifrado; adulterado, de outra chave, de outro cookie ou malformado: null. */
function unseal(aad: Buffer, value: string): Record<string, unknown> | null {
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 12 + 16 + 2 || raw.length > 2048) return null;
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(), raw.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Emitido há no máximo `ttlSeconds` (e não no futuro, além da folga). */
const fresh = (issuedAt: unknown, nowMs: number, ttlSeconds: number): boolean =>
  typeof issuedAt === 'number' &&
  nowMs - issuedAt >= -FUTURE_SKEW_MS &&
  nowMs - issuedAt <= ttlSeconds * 1000;

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128;

/** Cifra o estado da ida. */
export function sealGoogleState(payload: GoogleStatePayload): string {
  return seal(STATE_AAD, payload);
}

/** Abre o cookie da ida; adulterado, de outra chave, vencido ou malformado: null. */
export function openGoogleState(value: string, nowMs: number): GoogleStatePayload | null {
  const p = unseal(STATE_AAD, value);
  if (!p || !isText(p.state) || !isText(p.nonce) || !isText(p.verifier)) return null;
  if (!fresh(p.issuedAt, nowMs, GOOGLE_STATE_TTL_SECONDS)) return null;
  return { state: p.state, nonce: p.nonce, verifier: p.verifier, issuedAt: p.issuedAt as number };
}

/** O cookie da volta: o hash do código de uso único que foi para o endereço do web. */
export function sealGoogleReturn(code: string, nowMs: number): string {
  return seal(RETURN_AAD, { code: hashToken(code), issuedAt: nowMs });
}

/** O código trocado é o desta volta, neste navegador, e o cookie ainda vale? */
export function googleReturnMatches(value: string | null, code: string, nowMs: number): boolean {
  const p = value ? unseal(RETURN_AAD, value) : null;
  if (!p || typeof p.code !== 'string') return false;
  return (
    fresh(p.issuedAt, nowMs, GOOGLE_EXCHANGE_TTL_SECONDS) && safeEqual(p.code, hashToken(code))
  );
}

/** O valor de um cookie no cabeçalho Cookie (a API não usa cookie em mais nada). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Secure fora do desenvolvimento: em produção, e sempre que a volta é por https. No dev e nos
 * testes por http (localhost), o navegador recusaria um cookie Secure de um endereço que não é
 * localhost.
 */
const secureCookie = (): boolean =>
  env.NODE_ENV === 'production' || googleRedirectUri().startsWith('https:');

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: secureCookie(),
  sameSite: 'lax',
  path: COOKIE_PATH,
});

/** Opções do cookie da ida, gravado no start. */
export function googleStateCookieOptions(): CookieOptions {
  return { ...baseOptions(), maxAge: GOOGLE_STATE_TTL_SECONDS * 1000 };
}

/** Opções do cookie da volta, gravado no callback com o código. */
export function googleReturnCookieOptions(): CookieOptions {
  return { ...baseOptions(), maxAge: GOOGLE_EXCHANGE_TTL_SECONDS * 1000 };
}

/** Opções para apagar um dos dois (o mesmo caminho e as mesmas marcas de quando foi gravado). */
export function googleStateClearOptions(): CookieOptions {
  return baseOptions();
}
