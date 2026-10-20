import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Cifragem de campo em repouso (RNF-017): AES-256-GCM, IV aleatório de 12 bytes por valor e a tag
 * de autenticação de 16 bytes. O texto gravado é versionado e reconhecível,
 *
 *   enc:v1:<chave>:<iv>:<tag>:<cifra>      (iv, tag e cifra em base64url)
 *
 * e convive com as linhas antigas em texto puro: o que não começa com o prefixo é lido como está.
 * <chave> é a impressão da chave que cifrou (8 hex de um SHA-256 dela, que não a revela), para a
 * rotação: a FIELD_ENCRYPTION_KEY cifra e decifra, as FIELD_ENCRYPTION_OLD_KEYS só decifram. O
 * cabeçalho até a impressão entra como dado autenticado: mexer na versão ou na chave invalida a tag.
 *
 * Sem chave configurada, nada muda: `sealField` devolve o texto puro, como antes da 1.44.0.
 * Com IV aleatório o mesmo valor cifra diferente a cada vez: não dá para buscar, comparar nem
 * indexar pela coluna cifrada.
 */

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[0-9a-f]{8}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** O que aparece no lugar de um valor cifrado que não decifra (chave errada, dado corrompido). */
export const FIELD_UNAVAILABLE = '[indisponível]';

/** Por que um valor cifrado não pôde ser lido. Nunca carrega o valor. */
export type FieldFailure =
  | 'no_key' // nenhuma chave configurada
  | 'unknown_key' // cifrado com uma chave que não está entre a atual e as antigas
  | 'malformed' // tem o prefixo, mas não o formato
  | 'tampered'; // a tag não confere: dado adulterado ou corrompido

export type OpenedField = { ok: true; value: string } | { ok: false; reason: FieldFailure };

interface FieldKey {
  id: string;
  key: Buffer;
}

interface Keyring {
  current: FieldKey | null;
  byId: Map<string, Buffer>;
}

/** Impressão da chave: diz qual cifrou sem revelá-la (8 hex do SHA-256, com domínio próprio). */
export function fieldKeyId(key: Buffer): string {
  return createHash('sha256').update('escambo:field-key:').update(key).digest('hex').slice(0, 8);
}

/** Monta as chaves a partir do base64 (o env.ts já validou o formato e o tamanho). */
function keyringOf(current: string, old: string): Keyring {
  const byId = new Map<string, Buffer>();
  const add = (base64: string): FieldKey => {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) throw new Error('Chave de cifragem de campo precisa de 32 bytes');
    const id = fieldKeyId(key);
    byId.set(id, key);
    return { id, key };
  };
  for (const k of old.split(',')) {
    if (k.trim() !== '') add(k.trim());
  }
  return { current: current === '' ? null : add(current), byId };
}

const fromEnv = (): Keyring => keyringOf(env.FIELD_ENCRYPTION_KEY, env.FIELD_ENCRYPTION_OLD_KEYS);

let keyring = fromEnv();

/** Só para testes: troca as chaves (base64); null volta às do ambiente. */
export function setFieldKeysForTests(keys: { current?: string; old?: string[] } | null): void {
  keyring = keys ? keyringOf(keys.current ?? '', (keys.old ?? []).join(',')) : fromEnv();
}

/** Há chave atual: o que for gravado sai cifrado. */
export function fieldEncryptionEnabled(): boolean {
  return keyring.current !== null;
}

/** Tem o formato de valor cifrado (pelo prefixo; se decifra é com `openField`). */
export function isSealedField(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Começo de todo valor cifrado com a chave atual (para o SQL achar o que falta); null sem chave. */
export function currentSealPrefix(): string | null {
  return keyring.current ? `${PREFIX}${keyring.current.id}:` : null;
}

/** Cifra com a chave atual. Sem chave configurada devolve o texto como veio (RNF-017 desligado). */
export function sealField(plain: string): string {
  const current = keyring.current;
  if (!current) return plain;
  const header = `${PREFIX}${current.id}:`;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(header, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${header}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

export function sealNullableField(plain: string | null): string | null {
  return plain === null ? null : sealField(plain);
}

/** base64url canônico com o tamanho esperado: o que o Buffer ignoraria ou completaria não passa. */
function decode(part: string, bytes?: number): Buffer | null {
  if (!BASE64URL.test(part)) return null;
  const buf = Buffer.from(part, 'base64url');
  if (buf.toString('base64url') !== part) return null;
  return bytes === undefined || buf.length === bytes ? buf : null;
}

interface Sealed {
  header: string;
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

function parse(stored: string): Sealed | null {
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [keyId, iv, tag, data] = parts as [string, string, string, string];
  if (!KEY_ID.test(keyId)) return null;
  const ivBuf = decode(iv, IV_BYTES);
  const tagBuf = decode(tag, TAG_BYTES);
  const dataBuf = decode(data);
  if (!ivBuf || !tagBuf || !dataBuf) return null;
  return { header: `${PREFIX}${keyId}:`, keyId, iv: ivBuf, tag: tagBuf, data: dataBuf };
}

/**
 * Lê um valor gravado: texto puro (linha antiga, ou gravada sem chave) volta como está; cifrado
 * volta decifrado ou com o motivo de não ter decifrado. Não registra nada: quem chama sabe de que
 * linha veio e decide o que mostrar.
 */
export function openField(stored: string): OpenedField {
  if (!isSealedField(stored)) return { ok: true, value: stored };
  const sealed = parse(stored);
  if (!sealed) return { ok: false, reason: 'malformed' };
  if (keyring.byId.size === 0) return { ok: false, reason: 'no_key' };
  const key = keyring.byId.get(sealed.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(sealed.header, 'utf8'));
    decipher.setAuthTag(sealed.tag);
    const plain = Buffer.concat([decipher.update(sealed.data), decipher.final()]);
    return { ok: true, value: plain.toString('utf8') };
  } catch {
    // A tag não confere: o dado foi alterado (ou a chave com essa impressão não é a que cifrou).
    return { ok: false, reason: 'tampered' };
  }
}

export type ResealedField =
  | { status: 'current' } // já cifrado com a chave atual: fica como está
  | { status: 'sealed'; value: string } // texto puro ou chave antiga: cifrado com a atual
  | { status: 'unreadable'; reason: FieldFailure }; // cifrado e não decifra: fica como está

/**
 * Para o fields:encrypt: o que fazer com um valor gravado. Exige a chave atual. O que já tem a
 * impressão dela não é decifrado aqui (quem lê descobre se está íntegro).
 */
export function resealField(stored: string): ResealedField {
  const prefix = currentSealPrefix();
  if (!prefix) throw new Error('FIELD_ENCRYPTION_KEY não configurada: nada foi cifrado');
  if (stored.startsWith(prefix)) return { status: 'current' };
  const opened = openField(stored);
  if (!opened.ok) return { status: 'unreadable', reason: opened.reason };
  return { status: 'sealed', value: sealField(opened.value) };
}

/**
 * Uma linha na subida da API: cifragem ligada (com a impressão da chave, nunca a chave) ou o aviso
 * de que os dados de saque vão em texto puro — warn em produção, onde isso precisa ser visto.
 */
export function logFieldEncryptionStatus(production = env.NODE_ENV === 'production'): void {
  if (keyring.current) {
    logger.info(
      { keyId: keyring.current.id, oldKeys: keyring.byId.size - 1 },
      'Cifragem de campo ligada (RNF-017): chave PIX e dados bancários dos saques, e o segredo da verificação em duas etapas',
    );
    return;
  }
  const message =
    'FIELD_ENCRYPTION_KEY não configurada: a chave PIX e os dados bancários dos saques são ' +
    'gravados em TEXTO PURO (RNF-017), e a verificação em duas etapas fica indisponível (ADR 66). ' +
    'Gere com "openssl rand -base64 32", configure e rode o fields:encrypt para cifrar as linhas ' +
    'antigas';
  if (production) logger.warn(message);
  else logger.info(message);
}
