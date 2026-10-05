import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { bearer, routerApp } from '../../test-support/http';
import { asyncHandler } from '../../utils/async-handler';
import { serveMedia } from './media.controller';
import { fingerprint } from './media.image';
import { mediaRoutes } from './media.routes';

const { strikeSummary, userZone, matches, saveMedia, mediaVariantPath, uploadRateLimiter } =
  vi.hoisted(() => ({
    strikeSummary: vi.fn(),
    userZone: vi.fn(),
    matches: vi.fn(),
    saveMedia: vi.fn(),
    mediaVariantPath: vi.fn(),
    // O limite de verdade se desliga com NODE_ENV=test; este deixa passar e mostra onde ele fica na rota.
    uploadRateLimiter: vi.fn((_req: Request, _res: Response, next: NextFunction): void => next()),
  }));
vi.mock('../../middlewares/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middlewares/rate-limit')>()),
  uploadRateLimiter,
}));
vi.mock('../reports/moderation.strikes', () => ({ strikeSummary }));
vi.mock('../auth/user-zone', () => ({ userZone }));
vi.mock('./media.blocklist', () => ({ mediaBlocklist: { matches } }));
// Gravar e gerar miniatura são do media.storage (testado à parte); o caminho em disco e o limite
// de tamanho continuam os de verdade.
vi.mock('./media.storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media.storage')>();
  return { ...actual, saveMedia, mediaVariantPath };
});

// Como no app.ts: a leitura é pública e fica fora do router do módulo; o envio é o router.
const router = Router();
router.get('/:year/:month/:file', asyncHandler(serveMedia));
router.use(mediaRoutes);
const app = routerApp('/api/media', router);

const A = '01J8ZQ4K7M3VX5R2T9W6Y1B0CA';
const SAVED_URL = `/api/media/2026/10/${A}.webp`;

/** Imagem com detalhe (9 × 8 blocos de tons diferentes), para ter impressão perceptual. */
function detailed(cell: number): Promise<Buffer> {
  const width = 9 * cell;
  const height = 8 * cell;
  const raw = Buffer.alloc(width * height);
  let seed = 7;
  const tones = Array.from({ length: 72 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return 20 + (seed % 216);
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = tones[Math.floor(y / cell) * 9 + Math.floor(x / cell)]!;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/** O corpo da resposta em bytes, seja qual for o Content-Type (o supertest só guarda texto e JSON). */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

const originalDataDir = env.DATA_DIR;
let dir: string;

const inMedia = (key: string): string => path.join(dir, 'media', ...key.split('/'));
async function put(key: string, bytes: Buffer | string): Promise<string> {
  const abs = inMedia(key);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return abs;
}

/** Rotas e controller das imagens de perfil e portfólio: quem envia, o que é recusado, o que é servido. */
describe('mídia: borda HTTP', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    strikeSummary.mockResolvedValue({ strikes: 0, imageStrikes: 0, uploadsBlockedUntil: null });
    userZone.mockResolvedValue('America/Sao_Paulo');
    matches.mockResolvedValue(false);
    saveMedia.mockResolvedValue(SAVED_URL);
    dir = await mkdtemp(path.join(os.tmpdir(), 'escambo-media-http-'));
    env.DATA_DIR = dir;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    env.DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  describe('POST /api/media (envio)', () => {
    it('exige login', async () => {
      const semToken = await request(app)
        .post('/api/media')
        .attach('file', await detailed(4), 'foto.png');
      expect(semToken.status).toBe(401);
      expect(semToken.body.error).toBe('missing_token');

      const tokenRuim = await request(app)
        .post('/api/media')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .attach('file', await detailed(4), 'foto.png');
      expect(tokenRuim.status).toBe(401);
      expect(tokenRuim.body.error).toBe('invalid_token');

      expect(strikeSummary).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('reencoda em WebP, confere a lista de bloqueio com a imagem já processada, grava e devolve URL e dimensões', async () => {
      const upload = await detailed(10); // 90 × 80

      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', upload, 'foto.png')
        .expect(201);

      expect(saveMedia).toHaveBeenCalledTimes(1);
      const [saved, type] = saveMedia.mock.calls[0] as [Buffer, unknown];
      // O que vai para o disco é o WebP gerado aqui, nunca os bytes que o cliente mandou.
      expect(type).toEqual({ mime: 'image/webp', ext: 'webp', kind: 'image', names: ['webp'] });
      const meta = await sharp(saved).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 90, 80]);
      expect(res.body).toEqual({
        url: SAVED_URL,
        mime: 'image/webp',
        size: saved.length,
        width: 90,
        height: 80,
      });
      // A reincidência consultada é a de quem está logado.
      expect(strikeSummary).toHaveBeenCalledWith(7);
      expect(userZone).not.toHaveBeenCalled();
      // A impressão conferida é a da imagem processada (ADR 39), com assinatura e impressão perceptual.
      const print = await fingerprint(saved);
      expect(print.dhash).not.toBeNull();
      expect(matches).toHaveBeenCalledTimes(1);
      expect(matches).toHaveBeenCalledWith(print);
    });

    it('sem o campo purpose vale portfólio (sem recorte); com purpose=avatar sai quadrado (ADR 38)', async () => {
      const upload = await detailed(10); // 90 × 80

      const semCampo = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', upload, 'foto.png')
        .expect(201);
      expect([semCampo.body.width, semCampo.body.height]).toEqual([90, 80]);

      const portfolio = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .field('purpose', 'portfolio')
        .attach('file', upload, 'foto.png')
        .expect(201);
      expect([portfolio.body.width, portfolio.body.height]).toEqual([90, 80]);
      // Sem o campo e com purpose=portfolio sai a mesma imagem, byte a byte.
      expect((saveMedia.mock.calls[1]![0] as Buffer).equals(saveMedia.mock.calls[0]![0])).toBe(
        true,
      );

      const avatar = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .field('purpose', 'avatar')
        .attach('file', upload, 'foto.png')
        .expect(201);
      expect([avatar.body.width, avatar.body.height]).toEqual([80, 80]);
      const meta = await sharp(saveMedia.mock.calls[2]![0] as Buffer).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 80, 80]);
    });

    it('o limite de envios por IP vem depois do login e antes de ler o arquivo', async () => {
      // Sem token o pedido nem chega ao limite: quem não está logado não gasta a cota de ninguém.
      await request(app)
        .post('/api/media')
        .attach('file', await detailed(4), 'foto.png')
        .expect(401);
      expect(uploadRateLimiter).not.toHaveBeenCalled();

      // Estourado o limite, o multipart nem é lido: o arquivo no campo errado, que o leitor de
      // upload recusaria com 422, recebe o 429 do limite.
      uploadRateLimiter.mockImplementationOnce((_req, res) => {
        res.status(429).json({ error: 'too_many_requests', message: 'Muitos anexos' });
      });
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('image', await detailed(4), 'foto.png')
        .expect(429);

      expect(res.body.error).toBe('too_many_requests');
      expect(uploadRateLimiter).toHaveBeenCalledTimes(1);
      // O limite já vê quem está logado: o authenticate rodou antes dele.
      expect(uploadRateLimiter.mock.calls[0]![0].user).toEqual({
        sub: 'ulid-7',
        uid: 7,
        role: 'client',
      });
      expect(strikeSummary).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('envio dentro do limite passa pelo limite de envios uma vez e segue até gravar', async () => {
      await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', await detailed(4), 'foto.png')
        .expect(201);
      expect(uploadRateLimiter).toHaveBeenCalledTimes(1);
      expect(saveMedia).toHaveBeenCalledTimes(1);
    });

    it('purpose fora de avatar e portfolio é erro de validação e nada é gravado', async () => {
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .field('purpose', 'banner')
        .attach('file', await detailed(4), 'foto.png')
        .expect(422);

      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty('purpose');
      expect(matches).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('quem está bloqueado por reincidência não envia, e o aviso traz o fim do bloqueio no fuso da conta (ADR 41 e 46)', async () => {
      strikeSummary.mockResolvedValue({ uploadsBlockedUntil: '2026-10-05T17:30:00.000Z' });
      userZone.mockResolvedValue('America/Manaus');

      const res = await request(app)
        .post('/api/media')
        .set(bearer(9))
        .attach('file', await detailed(4), 'foto.png')
        .expect(403);

      expect(res.body).toEqual({
        error: 'uploads_restricted',
        message:
          'Envio de imagens bloqueado até 05/10/2026 às 13:30 por imagens removidas pela moderação',
      });
      expect(strikeSummary).toHaveBeenCalledWith(9);
      expect(userZone).toHaveBeenCalledWith(9);
      expect(matches).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('o bloqueio vem antes de olhar o arquivo: bloqueado sem arquivo recebe 403, não 422', async () => {
      strikeSummary.mockResolvedValue({ uploadsBlockedUntil: '2026-10-05T17:30:00.000Z' });
      const res = await request(app).post('/api/media').set(bearer(9)).send({}).expect(403);
      expect(res.body.error).toBe('uploads_restricted');
    });

    it('sem arquivo no campo "file" é recusado', async () => {
      const json = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .send({ purpose: 'avatar' })
        .expect(422);
      expect(json.body).toEqual({
        error: 'file_required',
        message: 'Envie a imagem no campo "file"',
      });

      const soCampos = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .field('purpose', 'avatar')
        .expect(422);
      expect(soCampos.body.error).toBe('file_required');
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('arquivo vazio é recusado', async () => {
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', Buffer.alloc(0), 'vazio.png')
        .expect(422);
      expect(res.body).toEqual({ error: 'empty_file', message: 'O arquivo está vazio' });
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('o tipo vem dos bytes: PDF, SVG ou HTML com nome e Content-Type de imagem são recusados', async () => {
      for (const bytes of [
        Buffer.from('%PDF-1.7\nconteúdo'),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        Buffer.from('<!doctype html><script>alert(1)</script>'),
      ]) {
        const res = await request(app)
          .post('/api/media')
          .set(bearer(7))
          .attach('file', bytes, { filename: 'foto.png', contentType: 'image/png' })
          .expect(422);
        expect(res.body).toEqual({
          error: 'not_an_image',
          message: 'Envie uma imagem JPG, PNG, GIF ou WebP',
        });
      }
      expect(matches).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('aceita JPG, GIF e WebP além de PNG, pelo conteúdo e não pelo nome, e tudo sai como WebP', async () => {
      const source = await detailed(10); // 90 × 80
      const uploads: [string, Buffer][] = [
        ['jpeg', await sharp(source).jpeg().toBuffer()],
        ['gif', await sharp(source).gif().toBuffer()],
        ['webp', await sharp(source).webp().toBuffer()],
      ];

      for (const [format, bytes] of uploads) {
        expect((await sharp(bytes).metadata()).format, format).toBe(format);
        // Nome e Content-Type genéricos: o que decide é o começo do arquivo.
        const res = await request(app).post('/api/media').set(bearer(7)).attach('file', bytes, {
          filename: 'arquivo.bin',
          contentType: 'application/octet-stream',
        });
        expect(res.status, format).toBe(201);
        expect([res.body.mime, res.body.width, res.body.height], format).toEqual([
          'image/webp',
          90,
          80,
        ]);
      }

      expect(saveMedia).toHaveBeenCalledTimes(3);
      for (const [saved, type] of saveMedia.mock.calls as [Buffer, { ext: string }][]) {
        expect((await sharp(saved).metadata()).format).toBe('webp');
        expect(type.ext).toBe('webp');
      }
    });

    it('arquivo com cara de PNG que a sharp não decodifica é recusado e não é gravado', async () => {
      const fake = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 7),
      ]);
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', fake, 'foto.png')
        .expect(422);
      expect(res.body.error).toBe('invalid_image');
      expect(matches).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('imagem que a moderação removeu é recusada e não é gravada (ADR 39)', async () => {
      matches.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', await detailed(4), 'foto.png')
        .expect(422);

      expect(res.body).toEqual({
        error: 'image_blocked',
        message: 'Esta imagem foi removida pela moderação e não pode ser usada no Escambo',
      });
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('se a consulta à lista de bloqueio falha, o envio falha junto: a imagem não passa como se estivesse liberada (ADR 39)', async () => {
      matches.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3306'));

      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', await detailed(4), 'foto.png')
        .expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(matches).toHaveBeenCalledTimes(1);
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('se a consulta da reincidência falha, o envio falha antes de processar a imagem: o bloqueio não é pulado (ADR 41)', async () => {
      strikeSummary.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3306'));

      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', await detailed(4), 'foto.png')
        .expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(strikeSummary).toHaveBeenCalledWith(7);
      expect(matches).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('arquivo acima de 5 MB é recusado antes de chegar ao controller', async () => {
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1, 1), 'grande.png')
        .expect(413);
      expect(res.body).toEqual({
        error: 'file_too_large',
        message: 'Arquivo maior que o limite de 5 MB',
      });
      expect(strikeSummary).not.toHaveBeenCalled();
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('arquivo de exatamente 5 MB cabe no limite de tamanho e chega ao controller', async () => {
      // Bytes que não são imagem: se passou do limite de tamanho, a recusa é pelo tipo, não 413.
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', Buffer.alloc(5 * 1024 * 1024, 1), 'no-limite.png')
        .expect(422);
      expect(res.body.error).toBe('not_an_image');
      expect(strikeSummary).toHaveBeenCalledWith(7);
    });

    it('arquivo em outro campo, ou mais de um arquivo, é envio inválido', async () => {
      const image = await detailed(4);
      const outroCampo = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('image', image, 'foto.png')
        .expect(422);
      expect(outroCampo.body).toEqual({
        error: 'invalid_upload',
        message: 'Envio inválido: esperado um único arquivo no campo "file"',
      });

      const dois = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', image, 'a.png')
        .attach('file', image, 'b.png')
        .expect(422);
      expect(dois.body.error).toBe('invalid_upload');
      expect(saveMedia).not.toHaveBeenCalled();
    });

    it('falha ao gravar em disco vira erro interno, sem vazar detalhe', async () => {
      saveMedia.mockRejectedValue(new Error('ENOSPC: disco cheio em /data/media'));
      const res = await request(app)
        .post('/api/media')
        .set(bearer(7))
        .attach('file', await detailed(4), 'foto.png')
        .expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('GET /api/media/:year/:month/:file (leitura pública)', () => {
    const key = `2026/09/${A}.png`;
    const notFound = { error: 'media_not_found', message: 'Imagem não encontrada' };

    it('serve o original sem login, com o tipo da extensão e cache imutável de um ano', async () => {
      const bytes = await detailed(4);
      await put(key, bytes);

      const res = await request(app)
        .get(`/api/media/${key}`)
        .buffer(true)
        .parse(binary)
        .expect(200);

      expect((res.body as Buffer).equals(bytes)).toBe(true);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Sem ?w= não se gera miniatura.
      expect(mediaVariantPath).not.toHaveBeenCalled();
    });

    it('o Content-Type segue a extensão gravada: jpg, gif e webp', async () => {
      for (const [ext, mime] of [
        ['jpg', 'image/jpeg'],
        ['gif', 'image/gif'],
        ['webp', 'image/webp'],
      ] as const) {
        await put(`2026/09/${A}.${ext}`, 'bytes');
        const res = await request(app).get(`/api/media/2026/09/${A}.${ext}`).expect(200);
        expect(res.headers['content-type'], ext).toBe(mime);
      }
    });

    it('endereço fora do formato é 404, mesmo com um arquivo desses em disco', async () => {
      await put(`2026/09/${A}.svg`, '<svg/>');
      await put(`2026/09/${A}.w128.webp`, 'miniatura');
      await put(`2026/09/${A.toLowerCase()}.png`, 'minúsculo');
      await put(`2026/13/${A}.png`, 'mês 13');
      await writeFile(path.join(dir, 'segredo.png'), 'fora da pasta de mídia');

      for (const url of [
        `/api/media/2026/09/${A}.svg`,
        // Miniatura não tem endereço próprio: só o original com ?w=.
        `/api/media/2026/09/${A}.w128.webp`,
        `/api/media/2026/09/${A.toLowerCase()}.png`,
        `/api/media/2026/13/${A}.png`,
        `/api/media/26/09/${A}.png`,
        `/api/media/2026/09/..%2F..%2F..%2Fsegredo.png`,
      ]) {
        const res = await request(app).get(url);
        expect(res.status, url).toBe(404);
        expect(res.body, url).toEqual(notFound);
        // Com ?w= também: endereço inválido nunca chega ao armazenamento para gerar miniatura.
        const withWidth = await request(app).get(`${url}?w=128`);
        expect(withWidth.status, `${url}?w=128`).toBe(404);
        expect(withWidth.body, `${url}?w=128`).toEqual(notFound);
      }
      expect(mediaVariantPath).not.toHaveBeenCalled();
    });

    it('imagem que não está em disco (expurgada ou removida) é 404', async () => {
      const res = await request(app).get(`/api/media/${key}`).expect(404);
      expect(res.body).toEqual(notFound);
    });

    it('?w= fora de 128, 480 e 960 (ou em outra grafia, ou repetido) é 400 e não gera nada', async () => {
      await put(key, 'original');
      for (const query of ['w=100', 'w=0128', 'w=128px', 'w=', 'w=128&w=480', 'w[]=128']) {
        const res = await request(app).get(`/api/media/${key}?${query}`);
        expect(res.status, query).toBe(400);
        expect(res.body, query).toEqual({
          error: 'invalid_width',
          message: 'Largura de miniatura não suportada (use 128, 480 ou 960)',
        });
      }
      expect(mediaVariantPath).not.toHaveBeenCalled();
    });

    it('com ?w= serve a miniatura (sempre WebP) pedida para a chave e a largura, com o mesmo cache', async () => {
      await put(key, 'original em png');
      const variant = await put(`2026/09/${A}.w128.webp`, 'miniatura em webp');
      mediaVariantPath.mockResolvedValue(variant);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const res = await request(app)
        .get(`/api/media/${key}?w=128`)
        .buffer(true)
        .parse(binary)
        .expect(200);

      // A largura chega como número da lista fechada, não como o texto da query.
      expect(mediaVariantPath).toHaveBeenCalledWith(key, 128);
      expect((res.body as Buffer).toString()).toBe('miniatura em webp');
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Miniatura servida não é o caminho de contingência: nenhum aviso no log.
      expect(warn).not.toHaveBeenCalled();
    });

    it('as três larguras aceitas chegam ao armazenamento', async () => {
      const variant = await put(`2026/09/${A}.w480.webp`, 'miniatura');
      mediaVariantPath.mockResolvedValue(variant);
      for (const width of [128, 480, 960]) {
        await request(app).get(`/api/media/${key}?w=${width}`).expect(200);
      }
      expect(mediaVariantPath.mock.calls).toEqual([
        [key, 128],
        [key, 480],
        [key, 960],
      ]);
    });

    it('miniatura de original que não existe é 404', async () => {
      mediaVariantPath.mockResolvedValue(null);
      const res = await request(app).get(`/api/media/${key}?w=480`).expect(404);
      expect(res.body).toEqual(notFound);
    });

    it('se a miniatura não pôde ser gerada, serve o original (com o tipo dele) e registra o aviso', async () => {
      await put(key, 'original em png');
      const boom = new Error('Input buffer contains unsupported image format');
      mediaVariantPath.mockRejectedValue(boom);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const res = await request(app)
        .get(`/api/media/${key}?w=480`)
        .buffer(true)
        .parse(binary)
        .expect(200);

      expect((res.body as Buffer).toString()).toBe('original em png');
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { err: boom, key, width: 480 },
        'miniatura não gerada; servindo o original',
      );
    });

    it('se a miniatura não pôde ser gerada e o original também não está em disco, é 404', async () => {
      mediaVariantPath.mockRejectedValue(new Error('falha na geração'));
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const res = await request(app).get(`/api/media/${key}?w=128`).expect(404);

      expect(res.body).toEqual(notFound);
    });

    it('DATA_DIR dentro de uma pasta começada por ponto (ex.: /home/app/.escambo) não bloqueia a imagem nem a miniatura', async () => {
      env.DATA_DIR = path.join(dir, '.escambo', 'data');
      const original = path.join(env.DATA_DIR, 'media', '2026', '09', `${A}.png`);
      const variant = path.join(env.DATA_DIR, 'media', '2026', '09', `${A}.w128.webp`);
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, 'original em png');
      await writeFile(variant, 'miniatura em webp');
      mediaVariantPath.mockResolvedValue(variant);

      const full = await request(app)
        .get(`/api/media/${key}`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      const thumb = await request(app)
        .get(`/api/media/${key}?w=128`)
        .buffer(true)
        .parse(binary)
        .expect(200);

      expect((full.body as Buffer).toString()).toBe('original em png');
      expect((thumb.body as Buffer).toString()).toBe('miniatura em webp');
    });

    it('dentro da pasta de mídia, arquivo em subpasta oculta continua recusado', async () => {
      mediaVariantPath.mockResolvedValue(await put(`2026/.oculta/${A}.w128.webp`, 'miniatura'));

      const res = await request(app).get(`/api/media/${key}?w=128`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'bad_request', message: 'Requisição inválida' });
    });

    it('falha de leitura que não é "arquivo não existe" não é mascarada como 404', async () => {
      // Uma pasta com nome de imagem: o envio do arquivo falha com EISDIR.
      await mkdir(inMedia(key), { recursive: true });
      const res = await request(app).get(`/api/media/${key}`).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  /**
   * O desfecho do envio do arquivo, direto no controller: a resposta falsa chama de volta com o
   * erro dado, como o send faz, para chegar aos casos que um pedido de verdade não reproduz (a
   * conexão que cai no meio, o arquivo que some entre a checagem e a leitura).
   */
  describe('serveMedia: quando o envio do arquivo falha', () => {
    const key = `2026/09/${A}.png`;
    const req = {
      params: { year: '2026', month: '09', file: `${A}.png` },
      query: {},
    } as unknown as Request;

    function fakeRes(err: unknown, headersSent: boolean) {
      const sendFile = vi.fn(
        (_abs: string, _options: unknown, done: (err?: unknown) => void): void => done(err),
      );
      return { sendFile, res: { sendFile, headersSent } as unknown as Response };
    }

    it('conexão que cai depois de o envio começar não vira erro: a resposta já saiu', async () => {
      const aborted = Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' });
      const { sendFile, res } = fakeRes(aborted, true);

      await expect(serveMedia(req, res)).resolves.toBeUndefined();

      // O arquivo pedido é o da chave, relativo à pasta de mídia (opção root); arquivo oculto nunca
      // é servido.
      expect(sendFile).toHaveBeenCalledTimes(1);
      expect(sendFile.mock.calls[0]![0]).toBe(path.join(...key.split('/')));
      expect(sendFile.mock.calls[0]![1]).toMatchObject({
        root: path.join(dir, 'media'),
        dotfiles: 'deny',
      });
    });

    it('a mesma falha antes de qualquer byte sair sobe como erro, para o cliente não ficar sem resposta', async () => {
      const aborted = Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' });
      const { res } = fakeRes(aborted, false);

      await expect(serveMedia(req, res)).rejects.toBe(aborted);
    });

    it('arquivo que sumiu na hora do envio é 404, venha o aviso pelo status do send ou pelo ENOENT', async () => {
      for (const gone of [
        Object.assign(new Error('Not Found'), { status: 404 }),
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      ]) {
        const { res } = fakeRes(gone, false);
        await expect(serveMedia(req, res), gone.message).rejects.toMatchObject({
          name: 'HttpError',
          statusCode: 404,
          code: 'media_not_found',
          message: 'Imagem não encontrada',
        });
      }
    });

    it('recusa do send que não é "não existe" (403) sobe como veio, sem virar 404', async () => {
      const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
      const { res } = fakeRes(forbidden, false);

      await expect(serveMedia(req, res)).rejects.toBe(forbidden);
    });
  });
});
