import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stripImageMetadata, stripJpeg, stripPng, stripWebp } from './media.strip';

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

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const IDAT = deflateSync(Buffer.from([0, 10, 20, 30]));

const jpegSeg = (marker: number, payload: Buffer): Buffer => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
};

const webpChunk = (fourcc: string, data: Buffer): Buffer => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, 'latin1'), size, data, pad]);
};
const riff = (chunks: Buffer[]): Buffer => {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
};

describe('stripPng (ADR 36)', () => {
  it('remove eXIf, tEXt, iTXt, zTXt e tIME e mantém os outros chunks byte a byte', () => {
    const clean = Buffer.concat([
      PNG_SIG,
      pngChunk('IHDR', IHDR),
      pngChunk('IDAT', IDAT),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const src = Buffer.concat([
      PNG_SIG,
      pngChunk('IHDR', IHDR),
      pngChunk('tEXt', Buffer.from('Location\0-26.3045,-48.8487 segredo')),
      pngChunk('eXIf', Buffer.from('MM\0*segredo-gps')),
      pngChunk('tIME', Buffer.from([7, 234, 9, 15, 10, 0, 0])),
      pngChunk('IDAT', IDAT),
      pngChunk('iTXt', Buffer.from('Author\0\0\0\0\0segredo')),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const out = stripPng(src);
    expect(out.includes('segredo')).toBe(false);
    expect(out).toEqual(clean);
  });

  it('PNG truncado volta como veio', () => {
    const src = Buffer.concat([PNG_SIG, pngChunk('IHDR', IHDR)]).subarray(0, 20);
    expect(stripPng(src)).toBe(src);
  });
});

describe('stripJpeg', () => {
  const app0 = jpegSeg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
  const dqt = jpegSeg(0xdb, Buffer.alloc(65, 1));
  const scan = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08]),
    Buffer.alloc(6, 2),
    Buffer.from('pixels'),
    Buffer.from([0xff, 0x00, 0xff, 0xd9]),
  ]);

  it('remove APP1 (EXIF/XMP), APP13 e comentário; mantém APP0, tabelas e o scan inteiro', () => {
    const src = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app0,
      jpegSeg(0xe1, Buffer.from('Exif\0\0GPS -26.3045 -48.8487 segredo')),
      jpegSeg(0xed, Buffer.from('Photoshop 3.0\0segredo')),
      dqt,
      jpegSeg(0xfe, Buffer.from('tirada no quintal de casa, segredo')),
      scan,
    ]);
    const out = stripJpeg(src);
    expect(out.includes('segredo')).toBe(false);
    expect(out).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, scan]));
  });

  it('bytes que não são JPEG, ou com segmento cortado, voltam iguais', () => {
    const notJpeg = Buffer.from('nada a ver');
    expect(stripJpeg(notJpeg)).toBe(notJpeg);
    const cut = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00]), Buffer.alloc(4)]);
    expect(stripJpeg(cut)).toBe(cut);
  });
});

describe('stripWebp', () => {
  it('remove EXIF e XMP, limpa as flags no VP8X e refaz o tamanho do RIFF', () => {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = VP8X_FLAGS_ALL;
    const src = riff([
      webpChunk('VP8X', vp8x),
      webpChunk('VP8L', Buffer.alloc(7, 3)),
      webpChunk('EXIF', Buffer.from('MM\0*segredo-gps')),
      webpChunk('XMP ', Buffer.from('<x:xmpmeta>segredo</x:xmpmeta>')),
    ]);
    const out = stripWebp(src);
    const cleanVp8x = Buffer.from(vp8x);
    cleanVp8x[0] = 0x10; // só a flag de alfa fica
    expect(out.includes('segredo')).toBe(false);
    expect(out).toEqual(
      riff([webpChunk('VP8X', cleanVp8x), webpChunk('VP8L', Buffer.alloc(7, 3))]),
    );
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
  });
});

// EXIF (0x08) + XMP (0x04) + alfa (0x10)
const VP8X_FLAGS_ALL = 0x08 | 0x04 | 0x10;

describe('stripImageMetadata', () => {
  it('escolhe pelo tipo e não mexe em GIF', () => {
    const gif = Buffer.from('GIF89a com comentário');
    expect(stripImageMetadata(gif, 'image/gif')).toBe(gif);
    const png = Buffer.concat([
      PNG_SIG,
      pngChunk('IHDR', IHDR),
      pngChunk('tEXt', Buffer.from('a\0b')),
      pngChunk('IDAT', IDAT),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(stripImageMetadata(png, 'image/png').includes('tEXt')).toBe(false);
  });
});
