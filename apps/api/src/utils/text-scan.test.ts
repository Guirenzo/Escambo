import { describe, expect, it } from 'vitest';
import { containsEmail, findEmails, replaceEmails, trimEndChar } from './text-scan';

/** As regex que as funções substituíram: o resultado tem de ser o mesmo. */
const EMAIL_G = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** Gerador determinístico (mulberry32): o mesmo sorteio a cada execução. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'Z', '7', '_', '-', '.', '+', '@', '@', '.', ' ', '!', 'é', '/', "'"];

function randomTexts(count: number): string[] {
  const next = rng(42);
  return Array.from({ length: count }, () => {
    const len = Math.floor(next() * 24);
    return Array.from({ length: len }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join(
      '',
    );
  });
}

/** Tempo de uma chamada, em milissegundos. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('trimEndChar', () => {
  it('tira só as repetições do fim, como /x+$/', () => {
    expect(trimEndChar('https://app.exemplo//', '/')).toBe('https://app.exemplo');
    expect(trimEndChar('/api/x', '/')).toBe('/api/x');
    expect(trimEndChar('///', '/')).toBe('');
    expect(trimEndChar('', '/')).toBe('');
    expect(trimEndChar('MZXW6===', '=')).toBe('MZXW6');
    for (const text of randomTexts(2000)) {
      expect(trimEndChar(text, '/')).toBe(text.replace(/\/+$/, ''));
    }
  });

  it('não fica quadrática com barras no meio do texto (S8786)', () => {
    const attack = `${'/'.repeat(100_000)}x`;
    expect(timed(() => trimEndChar(attack, '/'))).toBeLessThan(200);
  });
});

describe('e-mails no texto', () => {
  it('acha os mesmos e-mails que a regex', () => {
    expect(findEmails('fale com ana.souza+x@mail.com.br hoje')).toEqual([[9, 32]]);
    expect(replaceEmails("Duplicate entry 'a@b.co' for key", '[email]')).toBe(
      "Duplicate entry '[email]' for key",
    );
    expect(containsEmail('meu contato: nome@dominio')).toBe(false);
    expect(containsEmail('a@b@c.com')).toBe(true);
    for (const text of randomTexts(5000)) {
      expect(replaceEmails(text, '[e]')).toBe(text.replace(EMAIL_G, '[e]'));
      expect(containsEmail(text)).toBe(EMAIL.test(text));
    }
  });

  it('não fica quadrática com texto longo montado para isso (S8786)', () => {
    for (const attack of [
      'a'.repeat(100_000),
      'a@'.repeat(50_000),
      `${'a.'.repeat(50_000)}@`,
      `x@${'b-'.repeat(50_000)}`,
    ]) {
      expect(timed(() => replaceEmails(attack, '[email]'))).toBeLessThan(200);
    }
  });
});
