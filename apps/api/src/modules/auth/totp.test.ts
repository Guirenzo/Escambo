import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUrl,
  totpStep,
  verifyTotp,
} from './totp';

/** O segredo dos vetores de teste da RFC 6238 (apêndice B), para HMAC-SHA1. */
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const at = (seconds: number): Date => new Date(seconds * 1000);

/**
 * TOTP (RFC 6238) e base32 (RFC 4648) sem dependência: os vetores oficiais das duas RFCs, a janela
 * de um passo para cada lado e o anti-reuso pelo último passo aceito (ADR 66).
 */
describe('TOTP (RFC 6238)', () => {
  // Tempo (s) → código de 8 dígitos da RFC; os 6 do app são os 6 últimos (a truncagem é módulo).
  const VECTORS: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(VECTORS)('vetor da RFC em t=%i: %s (8 dígitos) e os 6 últimos', (seconds, code) => {
    const step = totpStep(at(seconds));
    expect(hotp(RFC_KEY, step, 8)).toBe(code);
    expect(hotp(RFC_KEY, step)).toBe(code.slice(2));
  });

  it('o passo é de 30 s, contado da época Unix', () => {
    expect(totpStep(at(0))).toBe(0);
    expect(totpStep(at(29))).toBe(0);
    expect(totpStep(at(30))).toBe(1);
    expect(totpStep(at(1111111109))).toBe(37037036);
  });

  it('aceita o passo atual e o vizinho de cada lado, e devolve qual foi', () => {
    const now = at(1111111111); // passo 37037037
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037037), now)).toBe(37037037);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037036), now)).toBe(37037036);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037038), now)).toBe(37037038);
  });

  it('fora da janela (dois passos de distância) não vale', () => {
    const now = at(1111111111);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037035), now)).toBeNull();
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037039), now)).toBeNull();
  });

  it('anti-reuso: só vale passo depois do último aceito (o mesmo código não entra duas vezes)', () => {
    const now = at(1111111111);
    const current = hotp(RFC_KEY, 37037037);
    expect(verifyTotp(RFC_KEY, current, now, 37037036)).toBe(37037037);
    expect(verifyTotp(RFC_KEY, current, now, 37037037)).toBeNull();
    // Depois de usar o passo atual, o código do passo anterior (ainda na janela) também não vale.
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037036), now, 37037037)).toBeNull();
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 37037038), now, 37037037)).toBe(37037038);
  });

  it('código que não é de 6 dígitos nem é comparado', () => {
    const now = at(59);
    for (const code of ['', '28708', '2870820', '94287082', 'abcdef', '287 082', '-28708']) {
      expect(verifyTotp(RFC_KEY, code, now), code).toBeNull();
    }
  });

  it('código errado de 6 dígitos não vale', () => {
    const now = at(59);
    const right = hotp(RFC_KEY, 1);
    const wrong = right === '000000' ? '000001' : '000000';
    expect(verifyTotp(RFC_KEY, wrong, now)).toBeNull();
  });
});

describe('base32 (RFC 4648)', () => {
  const VECTORS: [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(VECTORS)('"%s" vira "%s" (sem o "=") e volta igual', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded)?.toString()).toBe(plain);
  });

  it('a volta aceita minúsculas e o "=" do fim (como os apps mostram)', () => {
    expect(base32Decode('mzxw6ytboi======')?.toString()).toBe('foobar');
  });

  it('texto fora do alfabeto não decodifica', () => {
    for (const text of ['MZXW1', 'MZ XW', 'MZXW6YTB0I', 'é']) {
      expect(base32Decode(text), text).toBeNull();
    }
  });

  it('ida e volta de bytes quaisquer, inclusive os altos', () => {
    const bytes = Buffer.from([0, 255, 128, 1, 254, 127, 63, 200, 13, 37, 99]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

describe('segredo e QR', () => {
  it('o segredo novo tem 20 bytes aleatórios: 32 caracteres de base32, diferente a cada vez', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });

  it('o otpauth leva o e-mail codificado, o emissor e os parâmetros do app', () => {
    expect(otpauthUrl('ana+teste@escambo.test', 'JBSWY3DPEHPK3PXP')).toBe(
      'otpauth://totp/Escambo:ana%2Bteste%40escambo.test?secret=JBSWY3DPEHPK3PXP&issuer=Escambo&algorithm=SHA1&digits=6&period=30',
    );
  });
});
