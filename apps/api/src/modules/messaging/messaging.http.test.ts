import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { MAX_UPLOAD_BYTES } from '../../middlewares/upload';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { getAttachment, postAttachment } from './messaging.controller';
import { messagingRoutes } from './messaging.routes';
import { MESSAGE_MAX_LENGTH } from './messaging.schema';

const { service } = vi.hoisted(() => ({
  service: { history: vi.fn(), send: vi.fn(), sendAttachment: vi.fn(), attachment: vi.fn() },
}));
vi.mock('./messaging.service', () => ({ messagingService: service }));

const app = routerApp('/api/messaging', messagingRoutes);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 7),
]);

/** O corpo da resposta em bytes, seja qual for o Content-Type (o supertest só guarda texto e JSON). */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

/** Rotas e controllers do chat: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('chat: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('token inválido é barrado em todas as rotas do chat, antes de qualquer validação', async () => {
    const bad = { Authorization: 'Bearer nao-e-um-jwt' };
    const responses = [
      // Com id inválido de propósito: o 401 vem antes do 422.
      await request(app).get('/api/messaging/contracts/abc').set(bad),
      await request(app).post('/api/messaging/contracts/12').set(bad).send({ content: 'oi' }),
      await request(app).post('/api/messaging/contracts/12/attachments').set(bad),
      await request(app).get('/api/messaging/attachments/7').set(bad),
    ];

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('conta suspensa ou banida não lê nem envia no chat, mesmo com o token ainda válido (RN-007)', async () => {
    blocklist.add(7);
    try {
      const responses = [
        await request(app).get('/api/messaging/contracts/12').set(bearer(7)),
        await request(app)
          .post('/api/messaging/contracts/12')
          .set(bearer(7))
          .send({ content: 'oi' }),
        await request(app)
          .post('/api/messaging/contracts/12/attachments')
          .set(bearer(7))
          .attach('file', PNG, 'a.png'),
        await request(app).get('/api/messaging/attachments/7').set(bearer(7)),
      ];

      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    } finally {
      blocklist.delete(7);
    }

    // O bloqueio é da conta, não do chat: liberada, a mesma pessoa volta a ler.
    service.history.mockResolvedValue({ messages: [] });
    await request(app).get('/api/messaging/contracts/12').set(bearer(7)).expect(200);
    expect(service.history).toHaveBeenCalledWith(12, 7);
  });

  it('erro inesperado do service (banco fora do ar) vira 500 em JSON em todas as rotas, sem vazar o motivo (RNF-039)', async () => {
    const boom = new Error('ER_ACCESS_DENIED_ERROR: senha=segredo-do-banco');
    for (const fn of Object.values(service)) fn.mockRejectedValue(boom);

    const responses = [
      await request(app).get('/api/messaging/contracts/12').set(bearer(7)),
      await request(app).post('/api/messaging/contracts/12').set(bearer(7)).send({ content: 'oi' }),
      await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .attach('file', PNG, 'a.png'),
      await request(app).get('/api/messaging/attachments/9').set(bearer(7)),
    ];

    for (const res of responses) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(res.text).not.toContain('segredo-do-banco');
    }
    // Cada rota chegou ao service dela (o erro não veio de antes).
    expect(service.history).toHaveBeenCalledWith(12, 7);
    expect(service.send).toHaveBeenCalledWith(12, 7, 'oi');
    expect(service.sendAttachment).toHaveBeenCalledTimes(1);
    expect(service.attachment).toHaveBeenCalledWith(9, 7);
  });

  describe('GET /api/messaging/contracts/:id (histórico)', () => {
    it('exige login', async () => {
      const res = await request(app).get('/api/messaging/contracts/12');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.history).not.toHaveBeenCalled();
    });

    it('devolve o histórico do contrato pedido, visto por quem está logado', async () => {
      const history = { conversationId: 5, contractId: 12, otherPartyId: 20, messages: [] };
      service.history.mockResolvedValue(history);

      const res = await request(app).get('/api/messaging/contracts/12').set(bearer(7)).expect(200);

      expect(res.body).toEqual(history);
      // O id chega convertido para número; o usuário é o do token, nunca um parâmetro.
      expect(service.history).toHaveBeenCalledWith(12, 7);
    });

    it('id que não é inteiro positivo é erro de validação e não chega ao service', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app)
          .get(`/api/messaging/contracts/${id}`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.history).not.toHaveBeenCalled();
    });

    it('quem não é parte do contrato recebe a recusa do service, com o código dele', async () => {
      service.history.mockRejectedValue(
        new HttpError(403, 'Você não participa desta contratação', 'forbidden'),
      );
      const res = await request(app).get('/api/messaging/contracts/12').set(bearer(99)).expect(403);
      expect(res.body).toEqual({
        error: 'forbidden',
        message: 'Você não participa desta contratação',
      });
    });
  });

  describe('POST /api/messaging/contracts/:id (mensagem de texto)', () => {
    it('exige login', async () => {
      const res = await request(app).post('/api/messaging/contracts/12').send({ content: 'oi' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.send).not.toHaveBeenCalled();
    });

    it('envia em nome de quem está logado, com o texto sem os espaços das pontas, e responde 201', async () => {
      const message = { id: 31, conversationId: 5, senderId: 7, type: 'text', content: 'oi' };
      service.send.mockResolvedValue(message);

      const res = await request(app)
        .post('/api/messaging/contracts/12')
        .set(bearer(7))
        .send({ content: '  oi  ', senderId: 99 })
        .expect(201);

      expect(res.body).toEqual(message);
      expect(service.send).toHaveBeenCalledWith(12, 7, 'oi');
    });

    it('mensagem vazia, só de espaços ou ausente é recusada', async () => {
      for (const body of [{ content: '' }, { content: '   ' }, {}, { content: 42 }]) {
        const res = await request(app)
          .post('/api/messaging/contracts/12')
          .set(bearer(7))
          .send(body)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('content');
      }
      const empty = await request(app)
        .post('/api/messaging/contracts/12')
        .set(bearer(7))
        .send({ content: '   ' });
      expect(empty.body.details.content).toEqual(['Mensagem vazia']);
      expect(service.send).not.toHaveBeenCalled();
    });

    it('o texto vai até 2000 caracteres: com 2000 passa, com 2001 é recusado', async () => {
      expect(MESSAGE_MAX_LENGTH).toBe(2000);
      service.send.mockResolvedValue({ id: 32 });
      const limit = 'a'.repeat(2000);

      await request(app)
        .post('/api/messaging/contracts/12')
        .set(bearer(7))
        .send({ content: limit })
        .expect(201);
      expect(service.send).toHaveBeenCalledWith(12, 7, limit);

      const res = await request(app)
        .post('/api/messaging/contracts/12')
        .set(bearer(7))
        .send({ content: `${limit}a` })
        .expect(422);
      expect(res.body.details).toHaveProperty('content');
      expect(service.send).toHaveBeenCalledTimes(1);

      // O limite conta o texto já aparado: espaços nas pontas não gastam os 2000.
      await request(app)
        .post('/api/messaging/contracts/12')
        .set(bearer(7))
        .send({ content: `  ${limit}\n ` })
        .expect(201);
      expect(service.send).toHaveBeenCalledTimes(2);
      expect(service.send).toHaveBeenLastCalledWith(12, 7, limit);
    });

    it('id de contrato inválido é recusado antes de olhar o corpo', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/abc')
        .set(bearer(7))
        .send({ content: 'oi' })
        .expect(422);
      expect(res.body.details).toHaveProperty('id');
      expect(service.send).not.toHaveBeenCalled();
    });

    it('a recusa do service vira a resposta com o código dele', async () => {
      service.send.mockRejectedValue(
        new HttpError(404, 'Contratação não encontrada', 'contract_not_found'),
      );
      const res = await request(app)
        .post('/api/messaging/contracts/12')
        .set(bearer(7))
        .send({ content: 'oi' })
        .expect(404);
      expect(res.body).toEqual({
        error: 'contract_not_found',
        message: 'Contratação não encontrada',
      });
    });
  });

  describe('POST /api/messaging/contracts/:id/attachments (anexo, ADR 29)', () => {
    it('exige login', async () => {
      const res = await request(app).post('/api/messaging/contracts/12/attachments');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('entrega ao service o arquivo do campo "file" (bytes e nome) e a legenda aparada, em nome de quem está logado', async () => {
      const message = { id: 40, type: 'image', content: 'olha o rascunho' };
      service.sendAttachment.mockResolvedValue(message);

      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('content', '  olha o rascunho  ')
        .attach('file', PNG, { filename: 'rascunho.png', contentType: 'image/png' })
        .expect(201);

      expect(res.body).toEqual(message);
      expect(service.sendAttachment).toHaveBeenCalledTimes(1);
      const [contractId, uid, file, caption] = service.sendAttachment.mock.calls[0]!;
      expect(contractId).toBe(12);
      expect(uid).toBe(7);
      expect(caption).toBe('olha o rascunho');
      expect(file.originalname).toBe('rascunho.png');
      // O arquivo fica em memória: o service decide o tipo pelos bytes antes de gravar no disco.
      expect(Buffer.isBuffer(file.buffer)).toBe(true);
      expect(file.buffer.equals(PNG)).toBe(true);
    });

    it('sem legenda, o service recebe null', async () => {
      service.sendAttachment.mockResolvedValue({ id: 41 });

      await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .attach('file', PNG, 'a.png')
        .expect(201);

      const [contractId, uid, , caption] = service.sendAttachment.mock.calls[0]!;
      expect([contractId, uid, caption]).toEqual([12, 7, null]);
    });

    it('sem arquivo (só a legenda, ou um corpo JSON) é 422 file_required', async () => {
      const multipart = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('content', 'cadê o arquivo?')
        .expect(422);
      expect(multipart.body).toEqual({
        error: 'file_required',
        message: 'Envie um arquivo no campo "file"',
      });

      const json = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .send({ content: 'oi' })
        .expect(422);
      expect(json.body.error).toBe('file_required');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('arquivo em campo com outro nome é recusado: o campo é "file"', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .attach('arquivo', PNG, 'a.png')
        .expect(422);
      expect(res.body.error).toBe('invalid_upload');
      expect(res.body.message).toContain('"file"');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('arquivo acima do limite de tamanho (UPLOAD_MAX_MB) é 413 file_too_large e não chega ao service', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .attach('file', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1), 'grande.zip')
        .expect(413);
      expect(res.body.error).toBe('file_too_large');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('mais de um arquivo no mesmo envio é recusado: é um anexo por mensagem', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .attach('file', PNG, 'a.png')
        .attach('file', PNG, 'b.png')
        .expect(422);
      expect(res.body.error).toBe('invalid_upload');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('o envio de anexo tem teto próprio por IP (uploadRateLimiter): só essa rota passa por ele, e só depois do login', async () => {
      service.sendAttachment.mockResolvedValue({ id: 43 });
      service.send.mockResolvedValue({ id: 44 });
      service.history.mockResolvedValue({ messages: [] });
      const limit = env.UPLOAD_RATE_LIMIT_MAX;
      // Com NODE_ENV=test os limitadores ficam desligados (middlewares/rate-limit.ts): liga só aqui.
      env.NODE_ENV = 'production';
      try {
        const upload = await request(app)
          .post('/api/messaging/contracts/12/attachments')
          .set(bearer(7))
          .attach('file', PNG, 'a.png')
          .expect(201);
        // O teto anunciado é o dos anexos (envios por hora), não o geral da API nem o do login.
        expect(upload.headers['ratelimit-policy']).toBe(`${limit};w=3600`);
        expect(upload.headers['ratelimit']).toMatch(
          new RegExp(`^limit=${limit}, remaining=${limit - 1}, `),
        );

        // Envio recusado pelo controller (sem arquivo) também conta.
        const refused = await request(app)
          .post('/api/messaging/contracts/12/attachments')
          .set(bearer(7))
          .field('content', 'sem arquivo')
          .expect(422);
        expect(refused.headers['ratelimit']).toMatch(
          new RegExp(`^limit=${limit}, remaining=${limit - 2}, `),
        );

        // E o que o upload recusa (arquivo no campo errado) também: o teto é conferido ANTES de
        // ler o arquivo, senão quem estourou o limite ainda faria a API receber os bytes.
        const wrongField = await request(app)
          .post('/api/messaging/contracts/12/attachments')
          .set(bearer(7))
          .attach('arquivo', PNG, 'a.png')
          .expect(422);
        expect(wrongField.body.error).toBe('invalid_upload');
        expect(wrongField.headers['ratelimit']).toMatch(
          new RegExp(`^limit=${limit}, remaining=${limit - 3}, `),
        );

        // Sem login nem chega ao limitador: o 401 não gasta o teto de ninguém.
        const anonymous = await request(app)
          .post('/api/messaging/contracts/12/attachments')
          .expect(401);
        expect(anonymous.headers).not.toHaveProperty('ratelimit-policy');

        // Texto e histórico não têm o teto dos anexos.
        const text = await request(app)
          .post('/api/messaging/contracts/12')
          .set(bearer(7))
          .send({ content: 'oi' })
          .expect(201);
        expect(text.headers).not.toHaveProperty('ratelimit-policy');
        const history = await request(app)
          .get('/api/messaging/contracts/12')
          .set(bearer(7))
          .expect(200);
        expect(history.headers).not.toHaveProperty('ratelimit-policy');
      } finally {
        env.NODE_ENV = 'test';
      }
    });

    it('legenda com exatamente 2000 caracteres passa, e legenda só de espaços chega vazia (o service grava como ausente)', async () => {
      service.sendAttachment.mockResolvedValue({ id: 45 });
      const limit = 'a'.repeat(MESSAGE_MAX_LENGTH);

      await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('content', limit)
        .attach('file', PNG, 'a.png')
        .expect(201);
      await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('content', '   ')
        .attach('file', PNG, 'a.png')
        .expect(201);

      expect(service.sendAttachment.mock.calls.map((call) => call[3])).toEqual([limit, '']);
    });

    it('legenda acima de 2000 caracteres é recusada, mesmo com o arquivo certo', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('content', 'a'.repeat(2001))
        .attach('file', PNG, 'a.png')
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty('content');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('a legenda é UM texto: o campo repetido no multipart é recusado, não vira lista', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('content', 'primeira')
        .field('content', 'segunda')
        .attach('file', PNG, 'a.png')
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty('content');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('campos a mais no multipart (quem enviou, o tipo) são ignorados: valem o token e os bytes', async () => {
      service.sendAttachment.mockResolvedValue({ id: 46 });

      await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .field('senderId', '99')
        .field('uid', '99')
        .field('type', 'image')
        .attach('file', PNG, 'a.png')
        .expect(201);

      expect(service.sendAttachment).toHaveBeenCalledTimes(1);
      const args = service.sendAttachment.mock.calls[0]!;
      // Só os quatro argumentos de sempre, com o uid do token.
      expect(args).toHaveLength(4);
      expect([args[0], args[1], args[3]]).toEqual([12, 7, null]);
    });

    it('id de contrato inválido é erro de validação', async () => {
      const res = await request(app)
        .post('/api/messaging/contracts/0/attachments')
        .set(bearer(7))
        .attach('file', PNG, 'a.png')
        .expect(422);
      expect(res.body.details).toHaveProperty('id');
      expect(service.sendAttachment).not.toHaveBeenCalled();
    });

    it('requisição que chega sem corpo nenhum (nenhum parser preencheu req.body) segue com a legenda nula', async () => {
      service.sendAttachment.mockResolvedValue({ id: 42 });
      const file = { buffer: PNG, originalname: 'a.png' };
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const req = {
        params: { id: '12' },
        user: { sub: 'ulid-7', uid: 7, role: 'client' },
        file,
      };

      await postAttachment(req as unknown as Request, { status } as unknown as Response);

      expect(service.sendAttachment).toHaveBeenCalledWith(12, 7, file, null);
      expect(status).toHaveBeenCalledWith(201);
      expect(json).toHaveBeenCalledWith({ id: 42 });
    });

    it('tipo de arquivo recusado pelo service volta como 422 com o código dele', async () => {
      service.sendAttachment.mockRejectedValue(
        new HttpError(422, 'Tipo de arquivo não aceito', 'unsupported_file_type'),
      );
      const res = await request(app)
        .post('/api/messaging/contracts/12/attachments')
        .set(bearer(7))
        .attach('file', Buffer.from('<html></html>'), 'foto.png')
        .expect(422);
      expect(res.body).toEqual({
        error: 'unsupported_file_type',
        message: 'Tipo de arquivo não aceito',
      });
    });
  });

  describe('GET /api/messaging/attachments/:id (download do anexo)', () => {
    const realDataDir = env.DATA_DIR;
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'escambo-chat-http-'));
      env.DATA_DIR = dir;
    });
    afterEach(async () => {
      env.DATA_DIR = realDataDir;
      await rm(dir, { recursive: true, force: true });
    });

    /**
     * Arquivo de verdade em DATA_DIR/uploads + o que o service devolveria para ele. `name` é o
     * caminho dentro da pasta de uploads, com barra normal.
     */
    async function stored(name: string, bytes: Buffer, mime: string, disposition: string) {
      const file = path.join(env.DATA_DIR, 'uploads', ...name.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      service.attachment.mockResolvedValue({ path: file, mime, size: bytes.length, disposition });
    }

    it('exige login', async () => {
      const res = await request(app).get('/api/messaging/attachments/7');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.attachment).not.toHaveBeenCalled();
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-3', '2.5']) {
        const res = await request(app)
          .get(`/api/messaging/attachments/${id}`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.attachment).not.toHaveBeenCalled();
    });

    it('entrega os bytes do arquivo, pedido em nome de quem está logado', async () => {
      await stored('01KEY.png', PNG, 'image/png', `inline; filename="foto.png"`);

      const res = await request(app)
        .get('/api/messaging/attachments/7')
        .set(bearer(20))
        .buffer(true)
        .parse(binary)
        .expect(200);

      expect(service.attachment).toHaveBeenCalledWith(7, 20);
      expect((res.body as Buffer).equals(PNG)).toBe(true);
      expect(res.headers['content-length']).toBe(String(PNG.length));
    });

    it('tipo e nome de download vêm do que o service informou (o tipo real), não da extensão em disco', async () => {
      const pdf = Buffer.from('%PDF-1.7\nconteúdo');
      const disposition = `attachment; filename="or_amento.pdf"; filename*=UTF-8''or%C3%A7amento.pdf`;
      // Guardado com uma extensão que não diz nada: o cabeçalho tem de ser o do service.
      await stored('01KEY.bin', pdf, 'application/pdf', disposition);

      const res = await request(app)
        .get('/api/messaging/attachments/7')
        .set(bearer(20))
        .buffer(true)
        .parse(binary)
        .expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(disposition);
      expect((res.body as Buffer).equals(pdf)).toBe(true);
    });

    it('a resposta é privada (tem token) e o navegador não adivinha o tipo', async () => {
      await stored('01KEY.png', PNG, 'image/png', 'inline; filename="foto.png"');

      const res = await request(app)
        .get('/api/messaging/attachments/7')
        .set(bearer(20))
        .buffer(true)
        .parse(binary)
        .expect(200);

      // Nenhum cache compartilhado: o padrão do sendFile seria "public, max-age=0".
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('quem não é da conversa, mensagem removida e anexo expurgado: a recusa do service vira a resposta, sem arquivo', async () => {
      const refusals = [
        new HttpError(403, 'Você não participa desta conversa', 'forbidden'),
        new HttpError(404, 'Anexo não encontrado', 'attachment_not_found'),
        new HttpError(410, 'Esta mensagem foi removida pela moderação', 'message_removed'),
        new HttpError(
          410,
          'Este anexo foi removido pela política de retenção',
          'attachment_purged',
        ),
      ];
      for (const refusal of refusals) {
        service.attachment.mockRejectedValue(refusal);
        const res = await request(app)
          .get('/api/messaging/attachments/7')
          .set(bearer(99))
          .expect(refusal.statusCode);
        expect(res.body).toEqual({ error: refusal.code, message: refusal.message });
        expect(res.headers['content-disposition']).toBeUndefined();
        // A recusa é para quem pediu (o uid do token), sobre a mensagem pedida.
        expect(service.attachment).toHaveBeenLastCalledWith(7, 99);
      }
      expect(service.attachment).toHaveBeenCalledTimes(refusals.length);
    });

    it('se o arquivo some do disco entre a checagem e o envio, é o mesmo 404 attachment_missing do caminho normal, sem erro interno nem caminho do arquivo', async () => {
      const missing = path.join(dir, 'uploads', '2026', '09', 'sumiu.png');
      service.attachment.mockResolvedValue({
        path: missing,
        mime: 'image/png',
        size: 10,
        disposition: 'inline; filename="sumiu.png"',
      });
      const error = vi.spyOn(logger, 'error');

      const res = await request(app).get('/api/messaging/attachments/7').set(bearer(20));

      expect(res.status).toBe(404);
      expect(res.type).toBe('application/json');
      expect(res.body).toEqual({
        error: 'attachment_missing',
        message: 'O arquivo deste anexo não está mais disponível',
      });
      // Não é falha do servidor: nada vai para o log de erro (nem para o Sentry, que anda junto).
      expect(error).not.toHaveBeenCalled();
      // Nada do anexo vaza na resposta de erro: nem os cabeçalhos do arquivo, nem onde ele ficava.
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.text).not.toContain('sumiu.png');
      error.mockRestore();
    });

    it('arquivo oculto (nome começando com ponto) nunca é servido', async () => {
      await stored('.env.png', PNG, 'image/png', 'inline; filename="x.png"');

      const res = await request(app).get('/api/messaging/attachments/7').set(bearer(20));

      // O service liberou (o arquivo existe): quem barra é o envio, com dotfiles: 'deny'.
      expect(service.attachment).toHaveBeenCalledWith(7, 20);
      expect(res.status).toBe(403);
      expect(res.type).toBe('application/json');
      // Recusa genérica: nem os bytes, nem os cabeçalhos do arquivo, nem onde ele está.
      expect(res.body).toEqual({ error: 'bad_request', message: 'Requisição inválida' });
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.text).not.toContain('.env');
    });

    it('dentro da pasta de uploads, arquivo em subpasta oculta também não sai', async () => {
      await stored('2026/.oculta/01KEY.png', PNG, 'image/png', 'inline; filename="x.png"');

      const res = await request(app).get('/api/messaging/attachments/7').set(bearer(20));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'bad_request', message: 'Requisição inválida' });
      expect(res.headers['content-disposition']).toBeUndefined();
    });

    it('DATA_DIR dentro de uma pasta começada por ponto (ex.: /home/app/.escambo) não bloqueia o download: a recusa de oculto olha só dentro de uploads', async () => {
      env.DATA_DIR = path.join(dir, '.escambo', 'data');
      await stored('2026/09/01KEY.png', PNG, 'image/png', 'inline; filename="foto.png"');

      const res = await request(app)
        .get('/api/messaging/attachments/7')
        .set(bearer(20))
        .buffer(true)
        .parse(binary)
        .expect(200);

      expect((res.body as Buffer).equals(PNG)).toBe(true);
      expect(res.headers['content-type']).toBe('image/png');
    });

    describe('falha no meio do envio (controller direto, com uma resposta falsa)', () => {
      /** Resposta em que o sendFile "falha" com `err`, antes ou depois de os cabeçalhos saírem. */
      function failingResponse(err: Error, headersSent: boolean) {
        const sendFile = vi.fn((_file: string, _options: unknown, done: (e?: Error) => void) => {
          res.headersSent = headersSent;
          done(err);
        });
        const res = { headersSent: false, sendFile };
        return res;
      }
      const req = { params: { id: '7' }, user: { sub: 'ulid-20', uid: 20, role: 'client' } };
      /** O que o service devolve: o caminho absoluto, dentro de DATA_DIR/uploads. */
      const file = () => ({
        path: path.join(dir, 'uploads', '2026', '09', 'k.png'),
        mime: 'image/png',
        size: 3,
        disposition: 'inline',
      });

      it('erro antes de começar a responder sobe para o tratamento global', async () => {
        service.attachment.mockResolvedValue(file());
        const boom = Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
          status: 500,
        });
        const res = failingResponse(boom, false);

        await expect(
          getAttachment(req as unknown as Request, res as unknown as Response),
        ).rejects.toBe(boom);

        expect(service.attachment).toHaveBeenCalledWith(7, 20);
        const [sentPath, options] = res.sendFile.mock.calls[0]!;
        // A chave, relativa à pasta de uploads (opção root): o envio não sai dela.
        expect(sentPath).toBe(path.join('2026', '09', 'k.png'));
        // Arquivo oculto nunca sai, e o Cache-Control é o do controller (não o padrão do sendFile).
        expect(options).toMatchObject({
          root: path.join(dir, 'uploads'),
          dotfiles: 'deny',
          cacheControl: false,
        });
      });

      it('arquivo que sumiu na hora do envio é 404 attachment_missing, venha o aviso pelo status do send ou pelo ENOENT', async () => {
        for (const gone of [
          Object.assign(new Error('Not Found'), { status: 404 }),
          Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
        ]) {
          service.attachment.mockResolvedValue(file());
          const res = failingResponse(gone, false);
          await expect(
            getAttachment(req as unknown as Request, res as unknown as Response),
            gone.message,
          ).rejects.toMatchObject({
            name: 'HttpError',
            statusCode: 404,
            code: 'attachment_missing',
            message: 'O arquivo deste anexo não está mais disponível',
          });
        }
      });

      it('recusa do send que não é "não existe" (403 de arquivo oculto) sobe como veio, sem virar 404', async () => {
        service.attachment.mockResolvedValue(file());
        const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
        const res = failingResponse(forbidden, false);

        await expect(
          getAttachment(req as unknown as Request, res as unknown as Response),
        ).rejects.toBe(forbidden);
      });

      it('cliente que desiste no meio do download (cabeçalhos já enviados) não vira erro: não há mais o que responder', async () => {
        service.attachment.mockResolvedValue(file());
        const res = failingResponse(new Error('ECONNABORTED'), true);

        await expect(
          getAttachment(req as unknown as Request, res as unknown as Response),
        ).resolves.toBeUndefined();
        expect(res.sendFile).toHaveBeenCalledTimes(1);
      });
    });
  });
});
