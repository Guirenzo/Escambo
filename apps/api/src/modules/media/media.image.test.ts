import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AVATAR_SIDE, makeVariant, processUpload } from './media.image';

const solid = (width: number, height: number, background = '#0a6b3f') =>
  sharp({ create: { width, height, channels: 3, background } });

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** PNG de poucos bytes que se declara com `side` × `side` pixels. */
function pngDeclaring(side: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('processamento de imagens (ADR 38)', () => {
  it('avatar sai quadrado em WebP, recortado no centro e com no máximo 512 px', async () => {
    const out = await processUpload(await solid(2000, 1000).jpeg().toBuffer(), 'avatar');
    expect(out).toMatchObject({ width: AVATAR_SIDE, height: AVATAR_SIDE, animated: false });
    const meta = await sharp(out.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 512]);
  });

  it('avatar pequeno não é ampliado: o quadrado usa o menor lado', async () => {
    const out = await processUpload(await solid(300, 200).png().toBuffer(), 'avatar');
    expect([out.width, out.height]).toEqual([200, 200]);
  });

  it('portfólio cabe em 1600 px sem distorcer e sem ampliar', async () => {
    const wide = await processUpload(await solid(3200, 1200).png().toBuffer(), 'portfolio');
    expect([wide.width, wide.height]).toEqual([1600, 600]);
    const small = await processUpload(await solid(640, 480).png().toBuffer(), 'portfolio');
    expect([small.width, small.height]).toEqual([640, 480]);
  });

  it('aplica a orientação da câmera e descarta EXIF', async () => {
    const photo = await solid(40, 30)
      .jpeg()
      .withExif({ IFD0: { ImageDescription: 'quintal de casa -26.3045,-48.8487' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const out = await processUpload(photo, 'portfolio');
    expect([out.width, out.height]).toEqual([30, 40]);
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.data.includes('quintal')).toBe(false);
  });

  it('GIF animado continua animado no portfólio e vira foto parada no avatar', async () => {
    const red = await solid(80, 60, '#d33').png().toBuffer();
    const blue = await solid(80, 60, '#33d').png().toBuffer();
    const gif = await sharp([red, blue], { join: { animated: true } })
      .gif()
      .toBuffer();

    const portfolio = await processUpload(gif, 'portfolio');
    expect(portfolio).toMatchObject({ width: 80, height: 60, animated: true });
    expect((await sharp(portfolio.data, { animated: true }).metadata()).pages).toBe(2);

    const avatar = await processUpload(gif, 'avatar');
    expect(avatar).toMatchObject({ width: 60, height: 60, animated: false });
    expect((await sharp(avatar.data).metadata()).pages ?? 1).toBe(1);
  });

  it('arquivo corrompido é invalid_image; pixels demais é image_too_large', async () => {
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 1, 2, 3]);
    await expect(processUpload(broken, 'avatar')).rejects.toMatchObject({
      statusCode: 422,
      code: 'invalid_image',
    });
    await expect(processUpload(pngDeclaring(20_000), 'portfolio')).rejects.toMatchObject({
      statusCode: 422,
      code: 'image_too_large',
    });
  });

  it('miniatura cabe na largura pedida, sem distorcer nem ampliar', async () => {
    const original = (await processUpload(await solid(1200, 800).png().toBuffer(), 'portfolio'))
      .data;
    const thumb = await sharp(await makeVariant(original, 480)).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 480, 320]);
    const tiny = await sharp(
      await makeVariant(await solid(64, 64).png().toBuffer(), 128),
    ).metadata();
    expect([tiny.width, tiny.height]).toEqual([64, 64]);
  });
});
