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
  a.post('/public-dispute', (req) => {
    throw new HttpError(
      req.body.status ?? 409,
      'A disputa ainda não abriu',
      req.body.code ?? 'dispute_too_early',
      req.body.data,
    );
  });
  a.get('/zod', () => {
    z.object({ n: z.number() }).parse({ n: 'x' });
  });
  // Regra do objeto inteiro, sem path: o erro cai em formErrors, e não num campo.
  const atLeastOne = z
    .object({ name: z.string().optional(), alert: z.boolean().optional() })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nada para alterar' })
    .refine((v) => v.alert !== undefined, { message: 'Diga se quer o alerta' });
  a.post('/zod-form', (req) => {
    atLeastOne.parse(req.body);
  });
  // Campo inválido junto de uma regra do objeto: vale a mensagem genérica, com os campos.
  a.get('/zod-misto', () => {
    z.object({ n: z.string().min(3) })
      .superRefine((_v, ctx) => ctx.addIssue({ code: 'custom', message: 'Regra do objeto' }))
      .parse({ n: 'x' });
  });
  // Erros da raiz que não são regra do objeto: chave a mais no .strict(), corpo que é lista.
  const strictBody = z.object({ message: z.string().optional() }).strict();
  a.post('/zod-estrito', (req) => {
    strictBody.parse(req.body);
  });
  // Sem corpo nenhum para validar (o schema recebe undefined).
  a.get('/zod-sem-corpo', () => {
    z.object({ n: z.number() }).parse(undefined);
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

  it.each(['2026-10-10T15:00:00.000Z', null])(
    'a allowlist expõe opensAt %s no 409 dispute_too_early e descarta todo outro campo',
    async (opensAt) => {
      const res = await request(app())
        .post('/public-dispute')
        .send({
          data: { opensAt, contractId: 31, token: 'segredo', stack: 'interno', reason: 'privado' },
        })
        .expect(409);
      expect(res.body).toEqual({
        error: 'dispute_too_early',
        message: 'A disputa ainda não abriu',
        opensAt,
      });
      expect(captureError).not.toHaveBeenCalled();
    },
  );

  it.each([
    { opensAt: 'data inválida' },
    { opensAt: '2026-02-30T15:00:00.000Z' },
    { opensAt: '2026-10-10T12:00:00-03:00' },
    { opensAt: 123 },
    { opensAt: { password: 'segredo' } },
    { unrelated: 'interno' },
  ])('valor público fora do contrato não é serializado: %j', async (data) => {
    const res = await request(app()).post('/public-dispute').send({ data }).expect(409);
    expect(res.body).toEqual({ error: 'dispute_too_early', message: 'A disputa ainda não abriu' });
  });

  it.each([
    { code: 'conflict', status: 409 },
    { code: 'dispute_too_early', status: 400 },
  ])('outro erro/status não publica dados mesmo com opensAt válido: %j', async (fields) => {
    const res = await request(app())
      .post('/public-dispute')
      .send({ ...fields, data: { opensAt: '2026-10-10T15:00:00.000Z', secret: 'não publicar' } });
    expect(res.status).toBe(fields.status);
    expect(res.body).toEqual({ error: fields.code, message: 'A disputa ainda não abriu' });
  });

  it.each([1, 31, Number.MAX_SAFE_INTEGER])(
    'RN-020 publica somente o ID seguro %s da contratação no conflito 409',
    async (contractId) => {
      const res = await request(app())
        .post('/public-dispute')
        .send({
          code: 'active_contract_exists',
          data: {
            contractId,
            opensAt: '2026-10-10T15:00:00.000Z',
            title: 'Assunto privado',
            token: 'segredo',
          },
        })
        .expect(409);
      expect(res.body).toEqual({
        error: 'active_contract_exists',
        message: 'A disputa ainda não abriu',
        contractId,
      });
      expect(captureError).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '31', null, {}, [31]])(
    'RN-020 não serializa ID inválido: %j',
    async (contractId) => {
      const res = await request(app())
        .post('/public-dispute')
        .send({ code: 'active_contract_exists', data: { contractId } })
        .expect(409);
      expect(res.body).toEqual({
        error: 'active_contract_exists',
        message: 'A disputa ainda não abriu',
      });
    },
  );

  it.each([
    { code: 'conflict', status: 409 },
    { code: 'dispute_too_early', status: 409 },
    { code: 'active_contract_exists', status: 400 },
  ])('outro erro/status não publica contractId válido: %j', async (fields) => {
    const res = await request(app())
      .post('/public-dispute')
      .send({ ...fields, data: { contractId: 31, private: 'não publicar' } });
    expect(res.status).toBe(fields.status);
    expect(res.body).toEqual({ error: fields.code, message: 'A disputa ainda não abriu' });
  });

  it('erro de validação responde 422 com os campos, e não vai ao Sentry', async () => {
    const res = await request(app()).get('/zod').expect(422);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.details).toHaveProperty('n');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('regra do objeto inteiro (refine sem path) leva a mensagem dela, e não a genérica; details continua o dos campos', async () => {
    const res = await request(app()).post('/zod-form').send({}).expect(422);
    expect(res.body).toEqual({
      error: 'validation_error',
      message: 'Nada para alterar',
      details: {},
    });
    // Com o corpo vazio as duas regras falham, e vale a primeira; com só o nome, a segunda.
    const two = await request(app()).post('/zod-form').send({ name: 'Ana' }).expect(422);
    expect(two.body.message).toBe('Diga se quer o alerta');
    expect(captureError).not.toHaveBeenCalled();
  });

  it('com campo inválido, a mensagem é a genérica e os campos vão em details, mesmo havendo regra do objeto', async () => {
    const res = await request(app()).get('/zod-misto').expect(422);
    expect(res.body.message).toBe('Dados de entrada inválidos');
    expect(Object.keys(res.body.details)).toEqual(['n']);
  });

  it('erro da raiz que não é regra do objeto fica com a mensagem genérica, e não com o texto padrão do zod em inglês', async () => {
    const generic = {
      error: 'validation_error',
      message: 'Dados de entrada inválidos',
      details: {},
    };
    // Chave desconhecida no .strict() (o zod diria "Unrecognized key(s) in object: 'extra'").
    const extra = await request(app())
      .post('/zod-estrito')
      .send({ message: 'ok', extra: 1 })
      .expect(422);
    expect(extra.body).toEqual(generic);
    // Corpo que é lista ("Expected object, received array").
    const list = await request(app()).post('/zod-estrito').send([]).expect(422);
    expect(list.body).toEqual(generic);
    // Corpo que falta ("Required").
    const none = await request(app()).get('/zod-sem-corpo').expect(422);
    expect(none.body).toEqual(generic);
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
