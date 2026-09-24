import { readFile, stat, utimes } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runPurgeAttachments } from '../../src/jobs/purge-attachments';
import {
  MEDIA_URL_RE,
  mediaKeyFromUrl,
  mediaVariantKey,
} from '../../src/modules/media/media.paths';
import { mediaFilePath, saveMedia } from '../../src/modules/media/media.storage';

/**
 * Imagens de perfil e portfólio (ADR 36 e 38) contra o disco e o MySQL reais: envio autenticado e
 * reprocessado (WebP orientado, sem metadados, avatar quadrado), leitura pública com cache
 * imutável, miniaturas geradas na primeira leitura (inclusive de uploads antigos), recusas, uso no
 * perfil e no portfólio e expurgo das imagens que ninguém usa, junto com as miniaturas.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const DAY_MS = 86_400_000;

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#0a6b3f' } });
const png = (width: number, height: number): Promise<Buffer> =>
  solid(width, height).png().toBuffer();

/** Foto de câmera: JPEG com a descrição de onde foi tirada e orientação "girar 90°". */
const cameraPhoto = (width: number, height: number): Promise<Buffer> =>
  solid(width, height)
    .jpeg()
    .withExif({ IFD0: { ImageDescription: 'quintal de casa -26.3045,-48.8487' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();

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
/** "Bomba": PNG de poucos bytes que se declara com 20 000 × 20 000 px. */
function pixelBomb(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20_000, 0);
  ihdr.writeUInt32BE(20_000, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
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
const dims = async (buf: Buffer): Promise<unknown[]> => {
  const m = await sharp(buf).metadata();
  return [m.format, m.width, m.height];
};

let seq = 0;
async function actor(role: 'client' | 'freelancer'): Promise<{ token: string }> {
  const email = `int_media_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { token: login.body.accessToken as string };
}

const upload = (
  token: string,
  buf: Buffer,
  filename: string,
  contentType: string,
  purpose?: string,
) => {
  const req = request(app).post('/api/media').set(auth(token));
  if (purpose) void req.field('purpose', purpose);
  return req.attach('file', buf, { filename, contentType });
};

afterAll(async () => {
  await pool.end();
});

describe('Imagens de perfil e portfólio (ADR 36 e 38)', () => {
  it('foto de câmera vira WebP orientado e sem EXIF; qualquer um lê, com cache imutável', async () => {
    const u = await actor('client');
    const res = await upload(u.token, await cameraPhoto(300, 200), 'foto.jpg', 'image/jpeg');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ mime: 'image/webp', width: 200, height: 300 });
    expect(res.body.url).toMatch(MEDIA_URL_RE);
    expect(res.body.url.endsWith('.webp')).toBe(true);

    const got = await fetchMedia(res.body.url); // sem token
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/webp');
    expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    const body = got.body as Buffer;
    expect(res.body.size).toBe(body.length);
    expect(await dims(body)).toEqual(['webp', 200, 300]);
    expect((await sharp(body).metadata()).exif).toBeUndefined();
    expect(body.includes('quintal')).toBe(false);
  });

  it('avatar sai quadrado de até 512 px; portfólio cabe em 1600 px; propósito inventado é 422', async () => {
    const u = await actor('freelancer');
    const avatar = await upload(u.token, await png(2000, 1200), 'eu.png', 'image/png', 'avatar');
    expect(avatar.status, JSON.stringify(avatar.body)).toBe(201);
    expect(avatar.body).toMatchObject({ width: 512, height: 512 });
    expect(await dims((await fetchMedia(avatar.body.url).expect(200)).body as Buffer)).toEqual([
      'webp',
      512,
      512,
    ]);

    const work = await upload(u.token, await png(2400, 900), 'obra.png', 'image/png', 'portfolio');
    expect(work.body).toMatchObject({ width: 1600, height: 600 });

    const banner = await upload(u.token, await png(10, 10), 'x.png', 'image/png', 'banner');
    expect(banner.status).toBe(422);
  });

  it('miniatura: nasce na primeira leitura, fica ao lado do original e só nas larguras da lista', async () => {
    const u = await actor('freelancer');
    const { url } = (
      await upload(u.token, await png(1200, 800), 'obra.png', 'image/png').expect(201)
    ).body as { url: string };
    const key = mediaKeyFromUrl(url)!;

    const card = await fetchMedia(`${url}?w=480`).expect(200);
    expect(card.headers['content-type']).toBe('image/webp');
    expect(card.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(await dims(card.body as Buffer)).toEqual(['webp', 480, 320]);
    // Galeria em tela pequena (ADR 40).
    const large = await fetchMedia(`${url}?w=960`).expect(200);
    expect(await dims(large.body as Buffer)).toEqual(['webp', 960, 640]);
    const stored = await readFile(mediaFilePath(mediaVariantKey(key, 480))!);
    expect(stored.equals(card.body as Buffer)).toBe(true);
    const again = await fetchMedia(`${url}?w=480`).expect(200);
    expect((again.body as Buffer).equals(stored)).toBe(true);

    // Leituras simultâneas de uma miniatura nova esperam a mesma geração e recebem o mesmo arquivo.
    const small = await Promise.all([1, 2, 3].map(() => fetchMedia(`${url}?w=128`)));
    expect(small.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await dims(small[0]!.body as Buffer)).toEqual(['webp', 128, 85]);
    expect((small[1]!.body as Buffer).equals(small[2]!.body as Buffer)).toBe(true);

    for (const bad of ['100', '1600', '0128', 'abc']) {
      const r = await request(app).get(`${url}?w=${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toBe('invalid_width');
    }
    await request(app).get(`${url}?w=128&w=480`).expect(400);
    await request(app).get('/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp?w=128').expect(404);
  });

  it('imagem gravada antes do reprocessamento também ganha miniatura', async () => {
    // Como os uploads da v1.18: o PNG foi gravado como veio, só sem metadados.
    const legacy = await saveMedia(await png(640, 640), {
      mime: 'image/png',
      ext: 'png',
      kind: 'image',
      names: ['png'],
    });
    const original = await fetchMedia(legacy).expect(200);
    expect(original.headers['content-type']).toBe('image/png');
    const thumb = await fetchMedia(`${legacy}?w=128`).expect(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(await dims(thumb.body as Buffer)).toEqual(['webp', 128, 128]);
  });

  it('recusa o que não é imagem, imagem corrompida, pixels demais, sem login e acima de 5 MB', async () => {
    const u = await actor('client');
    const tiny = await png(8, 8);
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
    const broken = await upload(u.token, tiny.subarray(0, 40), 'quebrada.png', 'image/png');
    expect(broken.status).toBe(422);
    expect(broken.body.error).toBe('invalid_image');
    const bomb = await upload(u.token, pixelBomb(), 'bomba.png', 'image/png');
    expect(bomb.status).toBe(422);
    expect(bomb.body.error).toBe('image_too_large');

    const none = await request(app).post('/api/media').set(auth(u.token)).send({});
    expect(none.body.error).toBe('file_required');
    await request(app)
      .post('/api/media')
      .attach('file', tiny, { filename: 'a.png', contentType: 'image/png' })
      .expect(401);
    const big = await upload(
      u.token,
      Buffer.concat([tiny, Buffer.alloc(5 * 1024 * 1024)]),
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
    const avatar = (
      await upload(f.token, await png(96, 96), 'a.png', 'image/png', 'avatar').expect(201)
    ).body.url as string;
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
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela com foto', avatarUrl: `${avatar}?w=128` })
      .expect(422);

    const image = (await upload(f.token, await png(320, 200), 'b.png', 'image/png').expect(201))
      .body.url as string;
    const item = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Logo enviado do aparelho', imageUrl: image });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    // A criação devolve o portfólio inteiro (como no perfil rico), não só o item.
    expect((item.body as { imageUrl: string | null }[]).map((i) => i.imageUrl)).toContain(image);

    const c = await actor('client');
    const clientAvatar = (
      await upload(c.token, await png(64, 64), 'c.png', 'image/png', 'avatar').expect(201)
    ).body.url as string;
    await request(app)
      .put('/api/profiles/client')
      .set(auth(c.token))
      .send({ fullName: 'Cliente com foto', avatarUrl: clientAvatar })
      .expect(200);
  });

  it('expurgo: imagem não usada some depois de um dia, com a miniatura; a usada fica', async () => {
    const f = await actor('freelancer');
    const photo = await png(300, 300);
    const unused = (await upload(f.token, photo, 'solta.png', 'image/png', 'avatar').expect(201))
      .body.url as string;
    const used = (await upload(f.token, photo, 'usada.png', 'image/png', 'avatar').expect(201)).body
      .url as string;
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela do expurgo', avatarUrl: used })
      .expect(200);
    await fetchMedia(`${unused}?w=128`).expect(200);
    await fetchMedia(`${used}?w=128`).expect(200);
    const unusedThumb = mediaFilePath(mediaVariantKey(mediaKeyFromUrl(unused)!, 128))!;

    const old = new Date(Date.now() - 2 * DAY_MS);
    for (const url of [unused, used]) await utimes(mediaFilePath(mediaKeyFromUrl(url)!)!, old, old);

    const run = await runPurgeAttachments({ force: true, trigger: 'admin' });
    expect(run.orphansRemoved).toBeGreaterThanOrEqual(1);
    await fetchMedia(unused).expect(404);
    await expect(stat(unusedThumb)).rejects.toThrow();
    await fetchMedia(used).expect(200);
    await fetchMedia(`${used}?w=128`).expect(200);
  });
});
