import { utimes } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runPurgeAttachments } from '../../src/jobs/purge-attachments';
import { MEDIA_URL_RE, mediaKeyFromUrl } from '../../src/modules/media/media.paths';
import { mediaFilePath } from '../../src/modules/media/media.storage';

/**
 * Imagens de perfil e portfólio (ADR 36) contra o disco e o MySQL reais: envio autenticado,
 * leitura pública com cache imutável, metadados removidos, recusas, uso no perfil e no
 * portfólio e expurgo das imagens que ninguém usa.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const DAY_MS = 86_400_000;

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
/** PNG 1×1 válido com um tEXt de localização — o que um app de câmera poderia gravar. */
function pngWithLocation(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from('Location\0-26.3045,-48.8487 casa')),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 46, 160, 100]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function jpegSeg(marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}
function jpegWithExif(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSeg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    jpegSeg(0xe1, Buffer.from('Exif\0\0GPS -26.3045 -48.8487')),
    jpegSeg(0xfe, Buffer.from('tirada no quintal de casa')),
    jpegSeg(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08]),
    Buffer.alloc(6, 2),
    Buffer.from('pixels'),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const binary = (
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const fetchMedia = (url: string) => request(app).get(url).buffer(true).parse(binary);

let seq = 0;
async function actor(role: 'client' | 'freelancer'): Promise<{ token: string }> {
  const email = `int_media_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { token: login.body.accessToken as string };
}

const upload = (token: string, buf: Buffer, filename: string, contentType: string) =>
  request(app).post('/api/media').set(auth(token)).attach('file', buf, { filename, contentType });

afterAll(async () => {
  await pool.end();
});

describe('Imagens de perfil e portfólio (ADR 36)', () => {
  it('PNG: 201 com URL pública; qualquer um lê, com cache imutável e sem o tEXt de localização', async () => {
    const u = await actor('client');
    const res = await upload(u.token, pngWithLocation(), 'eu.png', 'image/png');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.mime).toBe('image/png');
    expect(res.body.url).toMatch(MEDIA_URL_RE);

    const got = await fetchMedia(res.body.url); // sem token
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    const body = got.body as Buffer;
    expect(body.includes('tEXt')).toBe(false);
    expect(body.includes('-48.8487')).toBe(false);
    expect(body.includes('IDAT')).toBe(true);
    expect(res.body.size).toBe(body.length);
  });

  it('JPEG: EXIF com GPS e comentário saem; os dados da imagem ficam', async () => {
    const u = await actor('client');
    const res = await upload(u.token, jpegWithExif(), 'foto.jpg', 'image/jpeg').expect(201);
    expect(res.body.url.endsWith('.jpg')).toBe(true);
    const body = (await fetchMedia(res.body.url).expect(200)).body as Buffer;
    expect(body.includes('Exif')).toBe(false);
    expect(body.includes('quintal')).toBe(false);
    expect(body.includes('pixels')).toBe(true);
  });

  it('recusa o que não é imagem, envio vazio, sem login e acima de 5 MB; caminho inválido é 404', async () => {
    const u = await actor('client');
    const pdf = await upload(u.token, Buffer.from('%PDF-1.4 nada'), 'x.png', 'image/png');
    expect(pdf.status).toBe(422);
    expect(pdf.body.error).toBe('not_an_image');
    const svg = await upload(
      u.token,
      Buffer.from('<svg onload="alert(1)"/>'),
      'x.svg',
      'image/svg+xml',
    );
    expect(svg.status).toBe(422);
    const none = await request(app).post('/api/media').set(auth(u.token)).send({});
    expect(none.body.error).toBe('file_required');
    await request(app)
      .post('/api/media')
      .attach('file', pngWithLocation(), { filename: 'a.png', contentType: 'image/png' })
      .expect(401);
    const big = await upload(
      u.token,
      Buffer.concat([pngWithLocation(), Buffer.alloc(5 * 1024 * 1024)]),
      'grande.png',
      'image/png',
    );
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('file_too_large');

    await request(app).get('/api/media/2026/09/..%2F..%2F..%2Fpackage.json').expect(404);
    await request(app).get('/api/media/2026/13/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.png').expect(404);
    await request(app).get('/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.png').expect(404);
  });

  it('perfil e portfólio aceitam a URL enviada; caminho de mídia inventado é 422', async () => {
    const f = await actor('freelancer');
    const avatar = (await upload(f.token, pngWithLocation(), 'a.png', 'image/png').expect(201)).body
      .url as string;
    const saved = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela com foto', city: 'Joinville', avatarUrl: avatar });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.avatarUrl).toBe(avatar);

    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela com foto', avatarUrl: '/api/media/qualquer-coisa.png' })
      .expect(422);

    const image = (await upload(f.token, pngWithLocation(), 'b.png', 'image/png').expect(201)).body
      .url as string;
    const item = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Logo enviado do aparelho', imageUrl: image });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    // A criação devolve o portfólio inteiro (como no perfil rico), não só o item.
    expect((item.body as { imageUrl: string | null }[]).map((i) => i.imageUrl)).toContain(image);

    const c = await actor('client');
    const clientAvatar = (
      await upload(c.token, pngWithLocation(), 'c.png', 'image/png').expect(201)
    ).body.url as string;
    await request(app)
      .put('/api/profiles/client')
      .set(auth(c.token))
      .send({ fullName: 'Cliente com foto', avatarUrl: clientAvatar })
      .expect(200);
  });

  it('expurgo: imagem enviada e não usada some depois de um dia; a usada fica', async () => {
    const f = await actor('freelancer');
    const unused = (await upload(f.token, pngWithLocation(), 'solta.png', 'image/png').expect(201))
      .body.url as string;
    const used = (await upload(f.token, pngWithLocation(), 'usada.png', 'image/png').expect(201))
      .body.url as string;
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela do expurgo', avatarUrl: used })
      .expect(200);

    const old = new Date(Date.now() - 2 * DAY_MS);
    for (const url of [unused, used]) await utimes(mediaFilePath(mediaKeyFromUrl(url)!)!, old, old);

    const run = await runPurgeAttachments({ force: true, trigger: 'admin' });
    expect(run.orphansRemoved).toBeGreaterThanOrEqual(1);
    await fetchMedia(unused).expect(404);
    await fetchMedia(used).expect(200);
  });
});
