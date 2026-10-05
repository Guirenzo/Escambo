import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import multer from 'multer';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/logger';
import { HttpError } from '../utils/http-error';
import { errorHandler } from './error-handler';
import { MAX_UPLOAD_BYTES, singleFile } from './upload';

// O error-handler é o de verdade: o Sentry entra falso para conferir o que vai (e o que não vai) a ele.
const { captureError } = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock('../config/sentry', () => ({ captureError }));

// Teto padrão de 1 MB (UPLOAD_MAX_MB), para o teste não depender do .env de quem roda nem
// precisar de um arquivo de 10 MB. O resto do env é o de verdade.
vi.mock('../config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/env')>();
  return { env: { ...original.env, UPLOAD_MAX_MB: 1 } };
});

const MB = 1024 * 1024;

/** Rota de teste: o middleware e, depois dele, o que ficou em req.file e req.body. */
function appWith(upload: RequestHandler, onError: ErrorRequestHandler = errorHandler): Express {
  const app = express();
  app.use(express.json());
  app.post('/upload', upload, (req, res) => {
    const file = req.file;
    res.json({
      file: file
        ? {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            // Em memória: o conteúdo está no buffer, nada vai para o disco.
            inMemory: Buffer.isBuffer(file.buffer) && file.path === undefined,
            head: file.buffer.subarray(0, 32).toString('utf8'),
          }
        : null,
      body: req.body,
    });
  });
  app.use(onError);
  return app;
}

/** Leitura de UM arquivo multipart em memória, com teto por rota e erros de código estável. */
describe('singleFile (upload)', () => {
  beforeEach(() => {
    captureError.mockClear();
    vi.restoreAllMocks();
  });

  it('o teto padrão é UPLOAD_MAX_MB em bytes', () => {
    expect(MAX_UPLOAD_BYTES).toBe(MB);
  });

  it('lê o arquivo do campo combinado em memória e os campos de texto em req.body', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .field('caption', 'Briefing do projeto')
      .attach('file', Buffer.from('conteúdo do anexo'), {
        filename: 'briefing.txt',
        contentType: 'text/plain',
      })
      .expect(200);

    expect(res.body).toEqual({
      file: {
        fieldname: 'file',
        originalname: 'briefing.txt',
        mimetype: 'text/plain',
        size: Buffer.byteLength('conteúdo do anexo'),
        inMemory: true,
        head: 'conteúdo do anexo',
      },
      body: { caption: 'Briefing do projeto' },
    });
  });

  it('arquivo acima do teto da rota é 413 file_too_large, com o limite em MB na mensagem', async () => {
    const app = appWith(singleFile('avatar', MB / 2));

    const res = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.alloc(MB / 2 + 1), 'foto.png')
      .expect(413);
    expect(res.body).toEqual({
      error: 'file_too_large',
      // Meio megabyte aparece com vírgula decimal, como se escreve em português.
      message: 'Arquivo maior que o limite de 0,5 MB',
    });

    // Exatamente no teto, passa.
    const ok = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.alloc(MB / 2), 'foto.png')
      .expect(200);
    expect(ok.body.file.size).toBe(MB / 2);
  });

  it('sem teto informado vale o padrão (UPLOAD_MAX_MB)', async () => {
    const app = appWith(singleFile('file'));

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'grande.bin')
      .expect(413);
    expect(res.body).toEqual({
      error: 'file_too_large',
      message: 'Arquivo maior que o limite de 1 MB',
    });

    // Exatamente no teto padrão, passa.
    const ok = await request(app)
      .post('/upload')
      .attach('file', Buffer.alloc(MAX_UPLOAD_BYTES), 'ok.bin')
      .expect(200);
    expect(ok.body.file.size).toBe(MAX_UPLOAD_BYTES);
  });

  it('arquivo em outro campo é 422 invalid_upload, citando o campo esperado', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .attach('documento', Buffer.from('x'), 'a.txt')
      .expect(422);
    expect(res.body).toEqual({
      error: 'invalid_upload',
      message: 'Envio inválido: esperado um único arquivo no campo "file"',
    });

    // O campo citado é o da rota: na de foto de perfil a mensagem fala em "avatar", e o arquivo
    // mandado em "file" (o campo de outra rota) é que é recusado.
    const avatar = await request(appWith(singleFile('avatar')))
      .post('/upload')
      .attach('file', Buffer.from('x'), 'a.txt')
      .expect(422);
    expect(avatar.body).toEqual({
      error: 'invalid_upload',
      message: 'Envio inválido: esperado um único arquivo no campo "avatar"',
    });
  });

  it('recusa do upload não deixa a rota rodar: nem o 413 nem o 422 chegam ao handler', async () => {
    const handler = vi.fn();
    const app = express();
    app.post('/upload', singleFile('file', 8), (req, res) => {
      handler(req.file?.originalname);
      res.json({ ok: true });
    });
    app.use(errorHandler);

    await request(app).post('/upload').attach('file', Buffer.alloc(9), 'grande.bin').expect(413);
    await request(app).post('/upload').attach('outro', Buffer.alloc(1), 'a.bin').expect(422);
    expect(handler).not.toHaveBeenCalled();

    // Dentro do teto, a rota roda uma vez com o arquivo lido.
    await request(app)
      .post('/upload')
      .attach('file', Buffer.alloc(8), 'ok.bin')
      .expect(200, { ok: true });
    expect(handler.mock.calls).toEqual([['ok.bin']]);
  });

  it('o limite aparece na mensagem em MB com no máximo uma casa decimal', async () => {
    // Um quarto de megabyte (0,25) é arredondado para 0,3.
    const res = await request(appWith(singleFile('file', MB / 4)))
      .post('/upload')
      .attach('file', Buffer.alloc(MB / 4 + 1), 'a.bin')
      .expect(413);
    expect(res.body).toEqual({
      error: 'file_too_large',
      message: 'Arquivo maior que o limite de 0,3 MB',
    });
  });

  it('o teto é de cada rota: o mesmo arquivo passa numa e é recusado noutra', async () => {
    const file = Buffer.alloc(MB / 2);
    await request(appWith(singleFile('file', MB)))
      .post('/upload')
      .attach('file', file, 'a.bin')
      .expect(200);
    const res = await request(appWith(singleFile('file', MB / 4)))
      .post('/upload')
      .attach('file', file, 'a.bin')
      .expect(413);
    expect(res.body.error).toBe('file_too_large');
  });

  it('mais de um arquivo é 422 invalid_upload', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .attach('file', Buffer.from('um'), 'a.txt')
      .attach('file', Buffer.from('dois'), 'b.txt')
      .expect(422);
    expect(res.body).toEqual({
      error: 'invalid_upload',
      message: 'Envio inválido: esperado um único arquivo no campo "file"',
    });
  });

  it('o arquivo certo acompanhado de um arquivo em outro campo também é 422 invalid_upload', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .attach('file', Buffer.from('um'), 'a.txt')
      .attach('extra', Buffer.from('dois'), 'b.txt')
      .expect(422);
    expect(res.body.error).toBe('invalid_upload');
  });

  it('campos de texto demais (mais de 5) ou grandes demais (acima de 4096 bytes) são 422 invalid_upload, com a mensagem do limite que passou', async () => {
    const app = appWith(singleFile('file'));

    const many = request(app).post('/upload');
    for (let i = 1; i <= 6; i++) many.field(`campo${i}`, 'x');
    const tooMany = await many.attach('file', Buffer.from('x'), 'a.txt').expect(422);
    expect(tooMany.body).toEqual({
      error: 'invalid_upload',
      message: 'Envio inválido: no máximo 5 campos de texto junto do arquivo',
    });

    const tooLong = await request(app)
      .post('/upload')
      .field('caption', 'x'.repeat(4097))
      .attach('file', Buffer.from('x'), 'a.txt')
      .expect(422);
    expect(tooLong.body).toEqual({
      error: 'invalid_upload',
      message: 'Envio inválido: o campo "caption" passa de 4096 bytes',
    });

    // Cinco campos de exatamente 4096 bytes cabem (o limite em si passa).
    const fits = request(app).post('/upload');
    for (let i = 1; i <= 5; i++) fits.field(`campo${i}`, 'x'.repeat(4096));
    const ok = await fits.attach('file', Buffer.from('x'), 'a.txt').expect(200);
    expect(Object.keys(ok.body.body)).toHaveLength(5);
    expect(ok.body.body.campo5).toHaveLength(4096);
  });

  it('nome de arquivo com acento chega como foi escrito (UTF-8), e não trocado como latin1', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .attach('file', Buffer.from('x'), {
        filename: 'relatório de ação — março.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);
    expect(res.body.file.originalname).toBe('relatório de ação — março.pdf');
  });

  it('requisição que não é multipart passa direto: sem req.file, e o corpo JSON chega intacto', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .send({ caption: 'só texto' })
      .expect(200);
    expect(res.body).toEqual({ file: null, body: { caption: 'só texto' } });
  });

  it('multipart sem arquivo passa: quem decide se o arquivo era obrigatório é o controller', async () => {
    const res = await request(appWith(singleFile('file')))
      .post('/upload')
      .field('caption', 'sem anexo')
      .expect(200);
    expect(res.body).toEqual({ file: null, body: { caption: 'sem anexo' } });
  });

  it('multipart malformado (cortado no meio ou sem boundary) é erro do cliente: 400 invalid_upload, sem log de erro nem Sentry', async () => {
    const logError = vi.spyOn(logger, 'error');
    const app = appWith(singleFile('file'));
    const MALFORMED = {
      error: 'invalid_upload',
      message: 'Envio inválido: o formulário multipart está malformado ou incompleto',
    };

    // Corpo que acaba antes do boundary final (o busboy acusa "Unexpected end of form").
    const cut = await request(app)
      .post('/upload')
      .set('Content-Type', 'multipart/form-data; boundary=corte')
      .send('--corte\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc')
      .expect(400);
    expect(cut.body).toEqual(MALFORMED);

    // multipart/form-data sem o parâmetro boundary.
    const noBoundary = await request(app)
      .post('/upload')
      .set('Content-Type', 'multipart/form-data')
      .send('qualquer coisa')
      .expect(400);
    expect(noBoundary.body).toEqual(MALFORMED);

    expect(logError).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it('o erro de corpo malformado vira HttpError antes do error-handler (o original não passa adiante)', async () => {
    const seen: unknown[] = [];
    const capture: ErrorRequestHandler = (err, _req, res, _next) => {
      seen.push(err);
      res.status(599).json({ captured: true });
    };

    await request(appWith(singleFile('file'), capture))
      .post('/upload')
      .set('Content-Type', 'multipart/form-data; boundary=corte')
      .send('--corte\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc')
      .expect(599);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(HttpError);
    expect(seen[0]).not.toBeInstanceOf(multer.MulterError);
    expect(seen[0]).toMatchObject({ statusCode: 400, code: 'invalid_upload' });
  });
});
