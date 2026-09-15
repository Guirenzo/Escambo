import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  hammingDistance,
  isInformativeHash,
  PERCEPTUAL_MATCH_BITS,
  perceptualHash,
} from './media.image';

/** 9 × 8 blocos de tons diferentes: uma imagem com detalhe, que dá impressão estável. */
function tones(seed: number): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < 72; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(20 + (s % 216));
  }
  return out;
}
function blocks(values: number[], cell = 60): Promise<Buffer> {
  const width = 9 * cell;
  const height = 8 * cell;
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = values[Math.floor(y / cell) * 9 + Math.floor(x / cell)]!;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

describe('impressão da imagem para a lista de bloqueio (ADR 39)', () => {
  it('a mesma imagem reencodada e reduzida fica a poucos bits; outra imagem fica longe', async () => {
    const original = await blocks(tones(7));
    const reencoded = await sharp(original).jpeg({ quality: 40 }).toBuffer();
    const smaller = await sharp(original).resize(270, 240).webp({ quality: 60 }).toBuffer();
    const other = await blocks(tones(99));

    const h = await perceptualHash(original);
    expect(isInformativeHash(h)).toBe(true);
    expect(hammingDistance(h, await perceptualHash(reencoded))).toBeLessThanOrEqual(
      PERCEPTUAL_MATCH_BITS,
    );
    expect(hammingDistance(h, await perceptualHash(smaller))).toBeLessThanOrEqual(
      PERCEPTUAL_MATCH_BITS,
    );
    expect(hammingDistance(h, await perceptualHash(other))).toBeGreaterThan(
      PERCEPTUAL_MATCH_BITS * 2,
    );
  });

  it('imagem lisa não tem impressão útil: só a assinatura exata vale para ela', async () => {
    const flat = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#777' },
    })
      .png()
      .toBuffer();
    expect(isInformativeHash(await perceptualHash(flat))).toBe(false);
    const print = await fingerprint(flat);
    expect(print.dhash).toBeNull();
    expect(print.sha256).toBe(createHash('sha256').update(flat).digest('hex'));
  });

  it('distância de Hamming conta os bits diferentes em 64 bits', () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0b1011n, 0b0001n)).toBe(2);
    expect(hammingDistance(2n ** 64n - 1n, 0n)).toBe(64);
    expect(isInformativeHash(0n)).toBe(false);
    expect(isInformativeHash(2n ** 64n - 1n)).toBe(false);
    expect(isInformativeHash(0xffff0000ffff0000n)).toBe(true);
  });
});
