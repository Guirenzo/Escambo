import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { env } from '../../config/env';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { lgpdRoutes } from './lgpd.routes';

const { service, audit } = vi.hoisted(() => ({
  service: {
    recordConsent: vi.fn(),
    getConsents: vi.fn(),
    requestDeletion: vi.fn(),
    getDeletionRequests: vi.fn(),
    requestExport: vi.fn(),
    getExportRequests: vi.fn(),
    openExport: vi.fn(),
  },
  audit: vi.fn(),
}));
vi.mock('./lgpd.service', () => ({ lgpdService: service }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: audit } }));

const app = routerApp('/api/lgpd', lgpdRoutes);

const AGENT = 'vitest-lgpd/1.0';
/** De onde veio o pedido, como o controller entrega ao service e à auditoria. */
const origin = { ip: expect.stringContaining('127.0.0.1'), userAgent: AGENT };

/**
 * Rotas e controllers da LGPD (consentimento, exclusão e portabilidade): quem pode chamar, o que
 * a validação recusa, o que chega ao service em nome de quem está logado e o que fica na
 * auditoria (RN-010).
 */
describe('LGPD: borda HTTP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.mockResolvedValue(undefined);
  });

  describe('acesso', () => {
    const routes: ['get' | 'post', string][] = [
      ['post', '/api/lgpd/consents'],
      ['get', '/api/lgpd/consents'],
      ['post', '/api/lgpd/deletion-requests'],
      ['get', '/api/lgpd/deletion-requests'],
      ['post', '/api/lgpd/export-requests'],
      ['get', '/api/lgpd/export-requests'],
      ['get', '/api/lgpd/export-requests/7/download'],
    ];

    afterEach(() => blocklist.delete(7));

    it('toda rota exige login, e sem ele nada chega ao service nem à auditoria', async () => {
      for (const [method, url] of routes) {
        const res = await request(app)[method](url);
        expect(res.status, `${method} ${url}`).toBe(401);
        expect(res.body.error).toBe('missing_token');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('token que não foi assinado pela API é recusado', async () => {
      const res = await request(app)
        .get('/api/lgpd/consents')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .expect(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.getConsents).not.toHaveBeenCalled();
    });

    it('token assinado com outro segredo, ou já vencido, não abre nenhuma rota', async () => {
      const claims = { sub: 'ulid-7', uid: 7, role: 'client' };
      const forged = jwt.sign(claims, 'segredo-de-outra-origem-0123456789', { expiresIn: '5m' });
      const expired = jwt.sign(claims, env.JWT_SECRET, { expiresIn: -60 });
      for (const token of [forged, expired]) {
        const auth = { Authorization: `Bearer ${token}` };
        for (const [method, url] of routes) {
          const res = await request(app)[method](url).set(auth);
          expect(res.status, `${method} ${url}`).toBe(401);
          expect(res.body.error).toBe('invalid_token');
        }
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('rota que o módulo não tem (apagar consentimento, alterar solicitação) é 404, não cai em outra', async () => {
      const missing: ['delete' | 'put' | 'patch' | 'get', string][] = [
        ['delete', '/api/lgpd/consents'],
        ['put', '/api/lgpd/deletion-requests/5'],
        ['patch', '/api/lgpd/export-requests/12'],
        ['get', '/api/lgpd/export-requests/12'],
      ];
      for (const [method, url] of missing) {
        const res = await request(app)[method](url).set(bearer(7));
        expect(res.status, `${method} ${url}`).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('os direitos do titular valem para qualquer papel logado: freelancer e admin veem os próprios dados', async () => {
      service.getConsents.mockResolvedValue([]);
      await request(app).get('/api/lgpd/consents').set(bearer(11, 'freelancer')).expect(200);
      await request(app).get('/api/lgpd/consents').set(bearer(3, 'admin')).expect(200);
      expect(service.getConsents.mock.calls).toEqual([[11], [3]]);
    });

    it('conta bloqueada (a exclusão concluída bloqueia na hora) não entra, mesmo com token válido', async () => {
      blocklist.add(7);
      // Em nenhuma rota: nem pede cópia, nem baixa a que já existe, nem registra consentimento.
      for (const [method, url] of routes) {
        const res = await request(app)[method](url).set(bearer(7));
        expect(res.status, `${method} ${url}`).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      // O bloqueio é de quem foi bloqueado: outra conta segue entrando.
      service.getExportRequests.mockResolvedValueOnce([]);
      await request(app).get('/api/lgpd/export-requests').set(bearer(8)).expect(200);
      expect(service.getExportRequests.mock.calls).toEqual([[8]]);
    });
  });

  describe('POST /api/lgpd/consents (RN-071)', () => {
    it('registra em nome de quem está logado, com IP e navegador, e deixa o aceite na auditoria', async () => {
      const consent = {
        type: 'privacy_policy',
        version: '1.4',
        accepted: true,
        at: '2026-10-01T12:00:00.000Z',
      };
      service.recordConsent.mockResolvedValue(consent);

      const res = await request(app)
        .post('/api/lgpd/consents')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        .send({ type: 'privacy_policy', version: '1.4', accepted: true })
        .expect(201);

      expect(res.body).toEqual(consent);
      expect(service.recordConsent).toHaveBeenCalledTimes(1);
      expect(service.recordConsent).toHaveBeenCalledWith(
        7,
        { type: 'privacy_policy', version: '1.4', accepted: true },
        origin,
      );
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: 7,
        action: 'lgpd_consent',
        entityType: 'consent',
        newValue: { type: 'privacy_policy', version: '1.4', accepted: true },
        ...origin,
      });
    });

    it('a retirada do consentimento (accepted: false) também é registrada e auditada', async () => {
      service.recordConsent.mockResolvedValue({ type: 'marketing', accepted: false });
      await request(app)
        .post('/api/lgpd/consents')
        .set(bearer(9))
        .set('User-Agent', AGENT)
        .send({ type: 'marketing', version: '2026-10', accepted: false })
        .expect(201);
      expect(service.recordConsent).toHaveBeenCalledWith(
        9,
        { type: 'marketing', version: '2026-10', accepted: false },
        origin,
      );
      expect(audit.mock.calls[0]![0]).toMatchObject({
        userId: 9,
        newValue: { type: 'marketing', version: '2026-10', accepted: false },
      });
    });

    it('sem o cabeçalho do navegador, o userAgent vai como null', async () => {
      service.recordConsent.mockResolvedValue({});
      await request(app)
        .post('/api/lgpd/consents')
        .set(bearer(7))
        .unset('User-Agent')
        .send({ type: 'marketing', version: '1', accepted: true })
        .expect(201);
      expect(service.recordConsent.mock.calls[0]![2]).toEqual({
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: null,
      });
      expect(audit.mock.calls[0]![0]).toMatchObject({ userAgent: null });
    });

    it('campo que o schema não conhece não chega ao service (ninguém registra em nome de outro)', async () => {
      service.recordConsent.mockResolvedValue({});
      await request(app)
        .post('/api/lgpd/consents')
        .set(bearer(7))
        .send({ type: 'marketing', version: '1', accepted: true, userId: 99 })
        .expect(201);
      expect(service.recordConsent.mock.calls[0]![0]).toBe(7);
      expect(service.recordConsent.mock.calls[0]![1]).toEqual({
        type: 'marketing',
        version: '1',
        accepted: true,
      });
      // A auditoria guarda o que foi validado, não o corpo cru, e sempre em nome de quem está logado.
      expect(audit.mock.calls[0]![0]).toMatchObject({ userId: 7 });
      expect(audit.mock.calls[0]![0].newValue).toEqual({
        type: 'marketing',
        version: '1',
        accepted: true,
      });
    });

    it('tipo desconhecido, aceite que não é booleano ou versão vazia: 422, sem registro nem auditoria', async () => {
      const invalid: [Record<string, unknown>, string][] = [
        [{ type: 'cookies', version: '1.0', accepted: true }, 'type'],
        [{ type: 'marketing', version: '1.0', accepted: 'sim' }, 'accepted'],
        [{ type: 'marketing', version: '', accepted: true }, 'version'],
        [{ type: 'marketing', version: 'x'.repeat(21), accepted: true }, 'version'],
        [{ type: 'marketing', version: '1.0' }, 'accepted'],
      ];
      for (const [body, field] of invalid) {
        const res = await request(app)
          .post('/api/lgpd/consents')
          .set(bearer(7))
          .send(body)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty(field);
      }
      expect(service.recordConsent).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('termos e política só em versão publicada (ADR 54)', async () => {
      const res = await request(app)
        .post('/api/lgpd/consents')
        .set(bearer(7))
        .send({ type: 'terms_of_use', version: '9.9', accepted: true })
        .expect(422);
      expect(res.body.details.version).toEqual(['Versão desconhecida deste documento']);
      expect(service.recordConsent).not.toHaveBeenCalled();
    });

    it('se o registro falha, a falha volta ao cliente e a auditoria não diz que houve aceite', async () => {
      service.recordConsent.mockRejectedValue(new Error('banco fora'));
      const res = await request(app)
        .post('/api/lgpd/consents')
        .set(bearer(7))
        .send({ type: 'marketing', version: '1', accepted: true })
        .expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/lgpd/consents', () => {
    it('devolve só os consentimentos de quem está logado', async () => {
      const list = [{ type: 'terms_of_use', version: '1.3', accepted: true, at: '2026-09-01' }];
      service.getConsents.mockResolvedValue(list);
      const res = await request(app).get('/api/lgpd/consents').set(bearer(7)).expect(200);
      expect(res.body).toEqual(list);
      expect(service.getConsents).toHaveBeenCalledTimes(1);
      expect(service.getConsents).toHaveBeenCalledWith(7);
    });
  });

  describe('listas do titular: vazio e falha', () => {
    const lists: [string, keyof typeof service][] = [
      ['/api/lgpd/consents', 'getConsents'],
      ['/api/lgpd/deletion-requests', 'getDeletionRequests'],
      ['/api/lgpd/export-requests', 'getExportRequests'],
    ];

    it('quem ainda não tem nada recebe 200 com a lista vazia', async () => {
      for (const [url, method] of lists) {
        service[method].mockResolvedValueOnce([]);
        const res = await request(app).get(url).set(bearer(7)).expect(200);
        expect(res.body, url).toEqual([]);
        expect(service[method].mock.calls, url).toEqual([[7]]);
      }
      // Consultar não deixa registro de ação na auditoria (só o que muda algo ou baixa a cópia).
      expect(audit).not.toHaveBeenCalled();
    });

    it('falha do service vira erro interno padronizado, sem vazar o motivo', async () => {
      for (const [url, method] of lists) {
        service[method].mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:3306'));
        const res = await request(app).get(url).set(bearer(7)).expect(500);
        expect(res.body, url).toEqual({
          error: 'internal_error',
          message: 'Erro interno do servidor',
        });
      }
    });
  });

  describe('POST /api/lgpd/deletion-requests (RN-072)', () => {
    const created = {
      id: 42,
      reason: 'não uso mais',
      status: 'pending',
      adminNote: null,
      createdAt: '2026-10-01T12:00:00.000Z',
      processedAt: null,
    };

    it('abre a solicitação de quem está logado, com o motivo, e audita com o id dela', async () => {
      service.requestDeletion.mockResolvedValue(created);

      const res = await request(app)
        .post('/api/lgpd/deletion-requests')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        .send({ reason: 'não uso mais' })
        .expect(201);

      expect(res.body).toEqual(created);
      expect(service.requestDeletion).toHaveBeenCalledWith(7, 'não uso mais');
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: 7,
        action: 'lgpd_deletion_requested',
        entityType: 'data_deletion_request',
        entityId: 42,
        ...origin,
      });
    });

    it('o motivo é opcional: ausente ou null chega ao service como null', async () => {
      service.requestDeletion.mockResolvedValue({ ...created, reason: null });
      await request(app).post('/api/lgpd/deletion-requests').set(bearer(7)).send({}).expect(201);
      await request(app)
        .post('/api/lgpd/deletion-requests')
        .set(bearer(7))
        .send({ reason: null })
        .expect(201);
      expect(service.requestDeletion.mock.calls).toEqual([
        [7, null],
        [7, null],
      ]);
    });

    it('motivo com mais de 1000 caracteres, ou que não é texto, é recusado', async () => {
      await request(app)
        .post('/api/lgpd/deletion-requests')
        .set(bearer(7))
        .send({ reason: 'x'.repeat(1000) })
        .expect(201);
      expect(service.requestDeletion).toHaveBeenCalledTimes(1);

      for (const reason of ['x'.repeat(1001), 123]) {
        const res = await request(app)
          .post('/api/lgpd/deletion-requests')
          .set(bearer(7))
          .send({ reason })
          .expect(422);
        expect(res.body.details).toHaveProperty('reason');
      }
      expect(service.requestDeletion).toHaveBeenCalledTimes(1);
    });

    it('a recusa do service (contratação aberta, saldo, pedido já em andamento) volta com o código dele e não é auditada', async () => {
      service.requestDeletion.mockRejectedValue(
        new HttpError(
          409,
          'Antes de excluir a conta, encerre o que ainda está aberto',
          'deletion_blocked',
        ),
      );
      const res = await request(app)
        .post('/api/lgpd/deletion-requests')
        .set(bearer(7))
        .send({ reason: 'x' })
        .expect(409);
      expect(res.body).toEqual({
        error: 'deletion_blocked',
        message: 'Antes de excluir a conta, encerre o que ainda está aberto',
      });
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/lgpd/deletion-requests', () => {
    it('devolve só as solicitações de quem está logado', async () => {
      const list = [{ id: 42, status: 'rejected', adminNote: 'Há uma disputa aberta' }];
      service.getDeletionRequests.mockResolvedValue(list);
      const res = await request(app).get('/api/lgpd/deletion-requests').set(bearer(8)).expect(200);
      expect(res.body).toEqual(list);
      expect(service.getDeletionRequests).toHaveBeenCalledTimes(1);
      expect(service.getDeletionRequests).toHaveBeenCalledWith(8);
    });
  });

  describe('POST /api/lgpd/export-requests (portabilidade, LGPD art. 18, V)', () => {
    it('gera a cópia de quem está logado e audita com o id e o estado em que ela ficou', async () => {
      const ready = {
        id: 12,
        status: 'ready',
        downloadUrl: '/api/lgpd/export-requests/12/download',
        expiresAt: '2026-10-08T12:00:00.000Z',
        createdAt: '2026-10-01T12:00:00.000Z',
        processedAt: '2026-10-01T12:00:01.000Z',
      };
      service.requestExport.mockResolvedValue(ready);

      const res = await request(app)
        .post('/api/lgpd/export-requests')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        // O corpo não manda em nada: a cópia é sempre a de quem está logado.
        .send({ userId: 99 })
        .expect(201);

      expect(res.body).toEqual(ready);
      expect(service.requestExport).toHaveBeenCalledTimes(1);
      expect(service.requestExport).toHaveBeenCalledWith(7);
      expect(audit).toHaveBeenCalledWith({
        userId: 7,
        action: 'lgpd_export_requested',
        entityType: 'data_export_request',
        entityId: 12,
        newValue: { status: 'ready' },
        ...origin,
      });
    });

    it('a geração que falhou responde 201 com o estado de falha, e a auditoria guarda esse estado', async () => {
      service.requestExport.mockResolvedValue({ id: 13, status: 'failed', downloadUrl: null });
      const res = await request(app).post('/api/lgpd/export-requests').set(bearer(7)).expect(201);
      expect(res.body).toEqual({ id: 13, status: 'failed', downloadUrl: null });
      expect(audit.mock.calls[0]![0]).toMatchObject({
        entityId: 13,
        newValue: { status: 'failed' },
      });
    });

    it('se nem o pedido pôde ser registrado, é erro interno e nada vai para a auditoria', async () => {
      service.requestExport.mockRejectedValue(new Error('banco fora'));
      const res = await request(app).post('/api/lgpd/export-requests').set(bearer(7)).expect(500);
      expect(res.body.error).toBe('internal_error');
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/lgpd/export-requests', () => {
    it('devolve só as exportações de quem está logado', async () => {
      const list = [{ id: 12, status: 'expired', downloadUrl: null }];
      service.getExportRequests.mockResolvedValue(list);
      const res = await request(app).get('/api/lgpd/export-requests').set(bearer(7)).expect(200);
      expect(res.body).toEqual(list);
      expect(service.getExportRequests).toHaveBeenCalledTimes(1);
      expect(service.getExportRequests).toHaveBeenCalledWith(7);
    });
  });

  describe('GET /api/lgpd/export-requests/:id/download', () => {
    const content = {
      formato: 'escambo-export/1.7',
      titular: { id: 7, email: 'ana@escambo.test' },
    };

    it('entrega o arquivo como download JSON, sem cache, pedido em nome de quem está logado', async () => {
      service.openExport.mockResolvedValue({
        stream: Readable.from([JSON.stringify(content)]),
        fileName: 'escambo-dados-2026-09-01.json',
      });

      const res = await request(app)
        .get('/api/lgpd/export-requests/12/download')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        .expect(200);

      // O id da URL chega como número, e o titular é o do token.
      expect(service.openExport).toHaveBeenCalledTimes(1);
      expect(service.openExport).toHaveBeenCalledWith(12, 7);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="escambo-dados-2026-09-01.json"',
      );
      // Dado pessoal: nenhum cache intermediário pode guardar a cópia.
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual(content);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: 7,
        action: 'lgpd_export_downloaded',
        entityType: 'data_export_request',
        entityId: 12,
        ...origin,
      });
    });

    it('id que não é inteiro positivo é erro de validação e não chega ao service', async () => {
      for (const id of ['abc', '0', '-3', '2.5']) {
        const res = await request(app)
          .get(`/api/lgpd/export-requests/${id}/download`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.openExport).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('exportação de outra pessoa: 403, sem cabeçalho de download e sem registro de que baixou', async () => {
      service.openExport.mockRejectedValue(
        new HttpError(403, 'Esta exportação não é sua', 'forbidden'),
      );
      const res = await request(app)
        .get('/api/lgpd/export-requests/12/download')
        .set(bearer(8))
        .expect(403);
      expect(service.openExport).toHaveBeenCalledWith(12, 8);
      expect(res.body).toEqual({ error: 'forbidden', message: 'Esta exportação não é sua' });
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(audit).not.toHaveBeenCalled();
    });

    it('arquivo que some entre a checagem e a leitura (o job de expiração apagou): 410 de exportação vencida, sem cabeçalho de download e sem derrubar a API', async () => {
      // Um ReadStream de verdade, criado na hora como no service, de um arquivo que não existe:
      // emite 'error' com ENOENT ao abrir.
      service.openExport.mockImplementation(async () => ({
        stream: createReadStream(path.join(os.tmpdir(), `escambo-nao-existe-${Date.now()}.json`)),
        fileName: 'escambo-dados-2026-09-01.json',
      }));

      const res = await request(app)
        .get('/api/lgpd/export-requests/12/download')
        .set(bearer(7))
        .expect(410);

      expect(res.body).toEqual({
        error: 'export_expired',
        message: 'Exportação expirada; solicite uma nova',
      });
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-disposition']).toBeUndefined();
      // A API segue de pé: o pedido seguinte é atendido.
      service.openExport.mockResolvedValue({
        stream: Readable.from([JSON.stringify(content)]),
        fileName: 'escambo-dados-2026-09-01.json',
      });
      const next = await request(app)
        .get('/api/lgpd/export-requests/12/download')
        .set(bearer(7))
        .expect(200);
      expect(next.body).toEqual(content);
    });

    it('erro de leitura antes de sair qualquer byte (que não é arquivo sumido) é erro interno padronizado', async () => {
      const stream = new Readable({
        read() {
          this.destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
        },
      });
      service.openExport.mockResolvedValue({ stream, fileName: 'escambo-dados-2026-09-01.json' });

      const res = await request(app)
        .get('/api/lgpd/export-requests/12/download')
        .set(bearer(7))
        .expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(res.headers['content-disposition']).toBeUndefined();
    });

    it('erro de leitura no meio do arquivo corta a conexão: o download nunca parece completo', async () => {
      async function* halfway(): AsyncGenerator<string> {
        yield '{"formato":"escambo-export/1.7",';
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      }
      service.openExport.mockResolvedValue({
        stream: Readable.from(halfway()),
        fileName: 'escambo-dados-2026-09-01.json',
      });

      const outcome = await request(app)
        .get('/api/lgpd/export-requests/12/download')
        .set(bearer(7))
        .then(
          () => 'resposta completa',
          (err: Error) => err.message,
        );

      // O cliente vê a conexão cair, nunca um JSON pela metade com status 200 de arquivo inteiro.
      expect(outcome).not.toBe('resposta completa');
    });

    it('exportação vencida, ainda não pronta ou inexistente volta com o código do service', async () => {
      const refusals: [number, string][] = [
        [410, 'export_expired'],
        [409, 'export_not_ready'],
        [404, 'export_not_found'],
      ];
      for (const [status, code] of refusals) {
        service.openExport.mockRejectedValueOnce(new HttpError(status, 'recusada', code));
        const res = await request(app)
          .get('/api/lgpd/export-requests/12/download')
          .set(bearer(7))
          .expect(status);
        expect(res.body).toEqual({ error: code, message: 'recusada' });
      }
      expect(audit).not.toHaveBeenCalled();
    });
  });
});
