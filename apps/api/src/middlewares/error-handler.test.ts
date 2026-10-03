import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpError } from '../utils/http-error';
import { errorHandler } from './error-handler';

const { captureError } = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock('../config/sentry', () => ({ captureError }));
vi.mock('../config/logger', () => ({ logger: { error: vi.fn() } }));

function app() {
  const a = express();
  a.use(express.json({ limit: '1kb' }));
  a.get('/http', () => {
    throw new HttpError(404, 'Contratação não encontrada', 'not_found');
  });
  a.get('/zod', () => {
    z.object({ n: z.number() }).parse({ n: 'x' });
  });
  a.get('/quebra', () => {
    throw new Error("Duplicate entry 'fulano@email.com' for key 'users.email'");
  });
  a.get('/p/:id', (_req, res) => {
    res.json({ ok: true });
  });
  a.post('/corpo', (_req, res) => {
    res.json({ ok: true });
  });
  a.use(errorHandler);
  return a;
}

describe('errorHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('erro de domínio responde o status e o código dele, e não vai ao Sentry', async () => {
    const res = await request(app()).get('/http').expect(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Contratação não encontrada' });
    expect(captureError).not.toHaveBeenCalled();
  });

  it('erro de validação responde 422 com os campos, e não vai ao Sentry', async () => {
    const res = await request(app()).get('/zod').expect(422);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.details).toHaveProperty('n');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('JSON malformado é 400 e corpo grande demais é 413, sem Sentry', async () => {
    const bad = await request(app())
      .post('/corpo')
      .set('Content-Type', 'application/json')
      .send('{"a":')
      .expect(400);
    expect(bad.body.error).toBe('invalid_json');
    const big = await request(app())
      .post('/corpo')
      .send({ a: 'x'.repeat(2048) })
      .expect(413);
    expect(big.body.error).toBe('payload_too_large');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('erro do cliente levantado pela camada HTTP responde o 4xx dela, sem Sentry', async () => {
    // Parâmetro com percent-encoding inválido: o Express lança URIError com status 400.
    const uri = await request(app()).get('/p/%E0%A4').expect(400);
    expect(uri.body).toEqual({ error: 'bad_request', message: 'Requisição inválida' });
    // Charset que o body-parser não conhece: 415.
    const charset = await request(app())
      .post('/corpo')
      .set('Content-Type', 'application/json; charset=x-nao-existe')
      .send('{}')
      .expect(415);
    expect(charset.body.error).toBe('bad_request');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('origem recusada pelo CORS é 403 do cliente, sem Sentry', async () => {
    const a = express();
    a.use(
      cors({
        origin: (_origin, cb) =>
          cb(new HttpError(403, 'Origem não permitida pelo CORS', 'cors_origin')),
      }),
    );
    a.get('/x', (_req, res) => {
      res.json({ ok: true });
    });
    a.use(errorHandler);
    const res = await request(a).get('/x').set('Origin', 'https://outro.site').expect(403);
    expect(res.body.error).toBe('cors_origin');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('falha do servidor responde 500 sem detalhe nenhum e vai ao Sentry uma vez', async () => {
    const res = await request(app()).get('/quebra').expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    expect(JSON.stringify(res.body)).not.toContain('fulano');
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.lastCall?.[0]).toBeInstanceOf(Error);
  });
});
