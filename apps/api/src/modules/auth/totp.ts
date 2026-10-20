import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP da verificação em duas etapas (RF-090, RNF-042, ADR 66): RFC 6238 sobre o HOTP da RFC 4226,
 * com HMAC-SHA1, passo de 30 s e 6 dígitos — o que todo app autenticador entende sem configurar
 * nada. Feito com node:crypto, sem dependência nova. Funções puras: o instante entra como
 * argumento, e quem guarda o último passo aceito (o anti-reuso) é o banco.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Passos aceitos antes e depois do atual: o relógio do celular pode estar uns segundos fora. */
export const TOTP_WINDOW = 1;
/** 160 bits, o tamanho do HMAC-SHA1 (RFC 4226, seção 4): em base32, 32 caracteres. */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 da RFC 4648, sem o "=" do fim (os apps aceitam e o QR fica menor). */
export function base32Encode(data: Buffer): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** O inverso de `base32Encode`; aceita minúsculas e o "=" do fim. Texto fora do alfabeto: null. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]*$/.test(clean)) return null;
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of clean) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo, aleatório, já em base32 (o que o app recebe pelo QR ou digitado). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** HOTP (RFC 4226): o código do contador, com a truncagem dinâmica e zeros à esquerda. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** O passo de 30 s em que o instante cai (o contador do HOTP). */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Confere o código contra o passo atual e o vizinho de cada lado e devolve o passo aceito, ou null.
 * Só vale passo depois de `lastUsedStep`: o mesmo código (ou um mais velho que o último aceito)
 * não entra duas vezes, nem se alguém o viu por cima do ombro. A comparação é em tempo constante.
 */
export function verifyTotp(
  key: Buffer,
  code: string,
  now: Date,
  lastUsedStep: number | null = null,
): number | null {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return null;
  const typed = Buffer.from(code);
  const current = totpStep(now);
  let accepted: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), typed) && accepted === null) {
      accepted = step;
    }
  }
  return accepted;
}

/** O conteúdo do QR (formato do Google Authenticator, que os outros apps seguem). */
export function otpauthUrl(email: string, secret: string): string {
  return (
    `otpauth://totp/Escambo:${encodeURIComponent(email)}?secret=${secret}` +
    `&issuer=Escambo&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}
