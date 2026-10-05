import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../config/logger';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { adminRoutes } from '../admin/admin.routes';
import { reportsRoutes } from './reports.routes';

const { service, moderation, health, recordAction, audit, captureError } = vi.hoisted(() => ({
  service: { create: vi.fn(), listMine: vi.fn() },
  moderation: { listQueue: vi.fn(), act: vi.fn() },
  health: { report: vi.fn(), history: vi.fn() },
  recordAction: vi.fn(),
  audit: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock('./reports.service', () => ({ reportsService: service }));
vi.mock('./reports.moderation', () => ({ moderationService: moderation }));
vi.mock('./moderation.health', () => ({ moderationHealthService: health }));
vi.mock('../admin/admin.repository', () => ({ adminRepository: { recordAction } }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: audit } }));
vi.mock('../../config/sentry', () => ({ captureError }));

const app = routerApp('/api/reports', reportsRoutes);
// As rotas do admin são as de verdade (admin.routes.ts), para o 403 vir do requireAdmin real.
const adminApp = routerApp('/api/admin', adminRoutes);

const ADMIN = bearer(1, 'admin');
const LOCAL_IP = expect.stringMatching(/127\.0\.0\.1$|^::1$/);

beforeEach(() => vi.resetAllMocks());

/** Denúncia feita pelo usuário (RF de denúncia, ADR 39): só logado, e sempre em nome de quem está logado. */
describe('denúncias do usuário: borda HTTP', () => {
  describe('POST /api/reports', () => {
    const created = {
      id: 15,
      targetType: 'service',
      targetId: 5,
      reason: 'fraud',
      status: 'pending',
      imageUrl: null,
      createdAt: '2026-09-15T15:00:00.000Z',
    };

    it('exige login', async () => {
      const res = await request(app)
        .post('/api/reports')
        .send({ targetType: 'service', targetId: 5, reason: 'fraud' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.create).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('token que não é do Escambo é 401 e não chega ao service', async () => {
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', 'Bearer nao-e-um-jwt')
        .send({ targetType: 'service', targetId: 5, reason: 'fraud' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('denuncia em nome de quem está logado, responde 201 e deixa o motivo na trilha de auditoria', async () => {
      service.create.mockResolvedValue(created);

      const res = await request(app)
        .post('/api/reports')
        .set(bearer(7))
        .set('User-Agent', 'vitest-agent')
        .send({ targetType: 'service', targetId: 5, reason: 'fraud', description: 'Parece golpe' })
        .expect(201);

      expect(res.body).toEqual(created);
      expect(service.create).toHaveBeenCalledTimes(1);
      expect(service.create).toHaveBeenCalledWith(7, {
        targetType: 'service',
        targetId: 5,
        reason: 'fraud',
        description: 'Parece golpe',
      });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: 7,
        action: 'content_reported',
        entityType: 'service',
        entityId: 5,
        newValue: { reason: 'fraud' },
        ip: LOCAL_IP,
        userAgent: 'vitest-agent',
      });
    });

    it('o endereço da imagem mandado pelo cliente não chega ao service (ADR 39): só os campos da denúncia', async () => {
      service.create.mockResolvedValue({ ...created, targetType: 'avatar', targetId: 9 });

      await request(app)
        .post('/api/reports')
        .set(bearer(7))
        .send({
          targetType: 'avatar',
          targetId: 9,
          reason: 'offensive',
          description: null,
          imageUrl: 'https://exemplo.test/outra.png',
          reporterId: 99,
        })
        .expect(201);

      expect(service.create).toHaveBeenCalledWith(7, {
        targetType: 'avatar',
        targetId: 9,
        reason: 'offensive',
        description: null,
      });
    });

    it('alvo ou motivo fora da lista, id que não é inteiro positivo e descrição acima de 2000 caracteres são recusados', async () => {
      const valid = { targetType: 'service', targetId: 5, reason: 'fraud' };
      const invalid: [Record<string, unknown>, string][] = [
        [{ ...valid, targetType: 'contract' }, 'targetType'],
        [{ ...valid, reason: 'feio' }, 'reason'],
        // O corpo é JSON: o id vem como número, texto não é convertido.
        [{ ...valid, targetId: '5' }, 'targetId'],
        [{ ...valid, targetId: 0 }, 'targetId'],
        [{ ...valid, targetId: 1.5 }, 'targetId'],
        [{ ...valid, description: 'x'.repeat(2001) }, 'description'],
        [{ targetId: 5, reason: 'fraud' }, 'targetType'],
      ];
      for (const [body, field] of invalid) {
        const res = await request(app).post('/api/reports').set(bearer(7)).send(body).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty(field);
      }
      expect(service.create).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();

      service.create.mockResolvedValue(created);
      await request(app)
        .post('/api/reports')
        .set(bearer(7))
        .send({ ...valid, description: 'x'.repeat(2000) })
        .expect(201);
    });

    it('a recusa do service (denúncia repetida) vira a resposta com o código dele, e nada vai para a auditoria', async () => {
      service.create.mockRejectedValue(
        new HttpError(
          409,
          'Você já denunciou esta imagem; a moderação vai analisar',
          'already_reported',
        ),
      );
      const res = await request(app)
        .post('/api/reports')
        .set(bearer(7))
        .send({ targetType: 'avatar', targetId: 9, reason: 'offensive' })
        .expect(409);
      expect(res.body).toEqual({
        error: 'already_reported',
        message: 'Você já denunciou esta imagem; a moderação vai analisar',
      });
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/reports', () => {
    it('exige login', async () => {
      const res = await request(app).get('/api/reports');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.listMine).not.toHaveBeenCalled();
    });

    it('devolve só as denúncias de quem está logado', async () => {
      const mine = [{ id: 15, targetType: 'service', targetId: 5, status: 'pending' }];
      service.listMine.mockResolvedValue(mine);

      const res = await request(app).get('/api/reports').set(bearer(7)).expect(200);

      expect(res.body).toEqual(mine);
      expect(service.listMine).toHaveBeenCalledTimes(1);
      expect(service.listMine).toHaveBeenCalledWith(7);
    });
  });
});

/** Fila de moderação e saúde da moderação na mão do admin (ADR 39, 47 e 55). */
describe('moderação pelo admin: borda HTTP', () => {
  describe('quem pode chamar', () => {
    const routes: ['get' | 'post', string][] = [
      ['get', '/api/admin/moderation/health'],
      ['get', '/api/admin/moderation/health/export.csv'],
      ['get', '/api/admin/reports'],
      ['post', '/api/admin/reports/12/dismiss'],
      ['post', '/api/admin/reports/12/remove-image'],
    ];

    it('sem login é 401', async () => {
      for (const [method, url] of routes) {
        const res = await request(adminApp)[method](url);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('missing_token');
      }
    });

    it('logado sem ser admin é 403, e nada chega à moderação nem às ações do admin', async () => {
      for (const role of ['client', 'freelancer']) {
        for (const [method, url] of routes) {
          const res = await request(adminApp)[method](url).set(bearer(9, role));
          expect(res.status).toBe(403);
          expect(res.body).toEqual({
            error: 'admin_only',
            message: 'Acesso restrito a administradores',
          });
        }
      }
      expect(health.report).not.toHaveBeenCalled();
      expect(health.history).not.toHaveBeenCalled();
      expect(moderation.listQueue).not.toHaveBeenCalled();
      expect(moderation.act).not.toHaveBeenCalled();
      expect(recordAction).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/moderation/health (ADR 47)', () => {
    it('sem ?days o período é de 30 dias; com ?days, o número convertido', async () => {
      const report = { windowDays: 30, queue: { pending: 2 }, slaHours: 24 };
      health.report.mockResolvedValue(report);

      const res = await request(adminApp).get('/api/admin/moderation/health').set(ADMIN);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(report);
      expect(health.report).toHaveBeenLastCalledWith(30);

      await request(adminApp).get('/api/admin/moderation/health?days=7').set(ADMIN).expect(200);
      expect(health.report).toHaveBeenLastCalledWith(7);
      await request(adminApp).get('/api/admin/moderation/health?days=365').set(ADMIN).expect(200);
      expect(health.report).toHaveBeenLastCalledWith(365);
      expect(health.report).toHaveBeenCalledTimes(3);
    });

    it('período fora de 1 a 365 dias, quebrado ou que não é número é erro de validação', async () => {
      for (const days of ['0', '366', '1.5', 'abc']) {
        const res = await request(adminApp)
          .get(`/api/admin/moderation/health?days=${days}`)
          .set(ADMIN)
          .expect(422);
        expect(res.body.details).toHaveProperty('days');
      }
      expect(health.report).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/moderation/health/export.csv (ADR 55)', () => {
    it('baixa a série como anexo CSV e registra a exportação em nome do admin logado', async () => {
      health.history.mockResolvedValue({
        history: [
          { day: '2026-09-18', received: 1, flagged: 0, actioned: 1, dismissed: 0, medianHours: 2 },
          {
            day: '2026-09-19',
            received: 3,
            flagged: 2,
            actioned: 0,
            dismissed: 2,
            medianHours: 30,
          },
        ],
        slaHours: 24,
      });

      const res = await request(adminApp)
        .get('/api/admin/moderation/health/export.csv?days=2')
        .set(ADMIN)
        .expect(200);

      expect(health.history).toHaveBeenCalledTimes(1);
      expect(health.history).toHaveBeenCalledWith(2);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="escambo-moderacao-2026-09-18_2026-09-19.csv"',
      );
      expect(res.text.startsWith('﻿dia;denuncias_recebidas;')).toBe(true);
      expect(res.text).toContain('2026-09-18;1;0;1;0;1;2,0;24;nao\r\n');
      // Mediana do dia acima da meta sai marcada.
      expect(res.text).toContain('2026-09-19;3;2;0;2;2;30,0;24;sim\r\n');
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction).toHaveBeenCalledWith(
        1,
        'moderation_health_exported',
        'moderation',
        null,
        '2 dias · 2026-09-18 → 2026-09-19',
      );
    });

    it('série vazia ainda baixa o cabeçalho, com o nome sem dia; período inválido não registra nada', async () => {
      health.history.mockResolvedValue({ history: [], slaHours: 24 });

      const res = await request(adminApp)
        .get('/api/admin/moderation/health/export.csv')
        .set(ADMIN)
        .expect(200);
      expect(health.history).toHaveBeenCalledWith(30);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="escambo-moderacao-sem-dia_sem-dia.csv"',
      );
      expect(res.text.startsWith('﻿dia;')).toBe(true);
      expect(recordAction).toHaveBeenCalledWith(
        1,
        'moderation_health_exported',
        'moderation',
        null,
        '30 dias ·  → ',
      );

      recordAction.mockClear();
      const bad = await request(adminApp)
        .get('/api/admin/moderation/health/export.csv?days=400')
        .set(ADMIN)
        .expect(422);
      expect(bad.body.details).toHaveProperty('days');
      expect(recordAction).not.toHaveBeenCalled();
    });

    it('exportação que não pôde ser registrada nas ações do admin não entrega o arquivo', async () => {
      health.history.mockResolvedValue({
        history: [
          { day: '2026-09-18', received: 1, flagged: 0, actioned: 1, dismissed: 0, medianHours: 2 },
        ],
        slaHours: 24,
      });
      recordAction.mockRejectedValueOnce(new Error('banco fora'));

      const res = await request(adminApp)
        .get('/api/admin/moderation/health/export.csv?days=7')
        .set(ADMIN)
        .expect(500);

      // Sem registro, sem CSV: a resposta é o erro padronizado, sem detalhe do banco.
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.text).not.toContain('2026-09-18');
    });
  });

  describe('GET /api/admin/reports (fila, ADR 39)', () => {
    it('sem filtro lista as pendentes; ?status=resolved, as resolvidas', async () => {
      moderation.listQueue.mockResolvedValue([{ id: 4, reports: 2 }]);

      const pending = await request(adminApp).get('/api/admin/reports').set(ADMIN).expect(200);
      expect(pending.body).toEqual([{ id: 4, reports: 2 }]);
      expect(moderation.listQueue).toHaveBeenLastCalledWith('pending');

      await request(adminApp).get('/api/admin/reports?status=resolved').set(ADMIN).expect(200);
      expect(moderation.listQueue).toHaveBeenLastCalledWith('resolved');
      expect(moderation.listQueue).toHaveBeenCalledTimes(2);
    });

    it('filtro desconhecido é erro de validação', async () => {
      const res = await request(adminApp)
        .get('/api/admin/reports?status=dismissed')
        .set(ADMIN)
        .expect(422);
      expect(res.body.details).toHaveProperty('status');
      expect(moderation.listQueue).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/reports/:id/:action', () => {
    const result = {
      status: 'actioned',
      reports: 2,
      referencesCleared: 1,
      fileRemoved: true,
      blocked: true,
      removalId: 31,
      ownerStrikes: 1,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    };
    const MEDIA = '/api/media/2026/09/01J8ZQ4K7M3VX5R2T9W6Y1B0CD.webp';
    const target = { type: 'avatar', id: 9, imageUrl: MEDIA };

    it('remover imagem: decide em nome do admin logado e registra o ALVO (não a denúncia) nas ações do admin e na auditoria', async () => {
      moderation.act.mockResolvedValue({ result, target });

      const res = await request(adminApp)
        .post('/api/admin/reports/12/remove-image')
        .set(ADMIN)
        .set('User-Agent', 'vitest-agent')
        .send({ note: '  Imagem ofensiva.  ' })
        .expect(200);

      // A resposta é só o resultado da decisão.
      expect(res.body).toEqual(result);
      expect(moderation.act).toHaveBeenCalledTimes(1);
      expect(moderation.act).toHaveBeenCalledWith(1, 12, 'remove-image', 'Imagem ofensiva.');
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction).toHaveBeenCalledWith(
        1,
        'image_removed',
        'avatar',
        9,
        'Imagem ofensiva.',
      );
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: 1,
        action: 'image_removed',
        entityType: 'avatar',
        entityId: 9,
        newValue: { reportId: 12, imageUrl: MEDIA, note: 'Imagem ofensiva.', ...result },
        ip: LOCAL_IP,
        userAgent: 'vitest-agent',
      });
    });

    it('cada decisão fica registrada com o seu nome', async () => {
      const recorded: [string, string][] = [
        ['dismiss', 'reports_dismissed'],
        ['resolve', 'reports_resolved'],
        ['remove-image', 'image_removed'],
        ['remove-content', 'content_removed'],
      ];
      const closed = { ...result, status: 'dismissed', removalId: null };
      const service7 = { type: 'service', id: 7, imageUrl: null };
      for (const [action, name] of recorded) {
        vi.clearAllMocks();
        moderation.act.mockResolvedValue({ result: closed, target: service7 });

        await request(adminApp).post(`/api/admin/reports/12/${action}`).set(ADMIN).expect(200);

        expect(moderation.act).toHaveBeenCalledWith(1, 12, action, null);
        expect(recordAction).toHaveBeenCalledWith(1, name, 'service', 7, null);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 1,
            action: name,
            entityType: 'service',
            entityId: 7,
            newValue: { reportId: 12, imageUrl: null, note: null, ...closed },
          }),
        );
      }
    });

    it('sem corpo, nota em branco ou nula vale como sem nota', async () => {
      moderation.act.mockResolvedValue({ result, target });
      const bodies: (Record<string, unknown> | undefined)[] = [
        undefined,
        {},
        { note: '   ' },
        { note: null },
      ];
      for (const body of bodies) {
        const req = request(adminApp).post('/api/admin/reports/12/dismiss').set(ADMIN);
        await (body === undefined ? req : req.send(body)).expect(200);

        expect(moderation.act).toHaveBeenLastCalledWith(1, 12, 'dismiss', null);
        expect(recordAction).toHaveBeenLastCalledWith(1, 'reports_dismissed', 'avatar', 9, null);
      }
      expect(moderation.act).toHaveBeenCalledTimes(4);
    });

    it('ação desconhecida, id inválido ou nota acima de 500 caracteres é erro de validação', async () => {
      const unknown = await request(adminApp)
        .post('/api/admin/reports/12/ban')
        .set(ADMIN)
        .expect(422);
      expect(unknown.body.details).toHaveProperty('action');

      for (const id of ['abc', '0', '-2', '1.5']) {
        const badId = await request(adminApp)
          .post(`/api/admin/reports/${id}/dismiss`)
          .set(ADMIN)
          .expect(422);
        expect(badId.body.details).toHaveProperty('id');
      }

      const longNote = await request(adminApp)
        .post('/api/admin/reports/12/dismiss')
        .set(ADMIN)
        .send({ note: 'x'.repeat(501) })
        .expect(422);
      expect(longNote.body.details).toHaveProperty('note');

      expect(moderation.act).not.toHaveBeenCalled();
      expect(recordAction).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();

      moderation.act.mockResolvedValue({ result, target });
      await request(adminApp)
        .post('/api/admin/reports/12/dismiss')
        .set(ADMIN)
        .send({ note: 'x'.repeat(500) })
        .expect(200);
    });

    it('a resposta só sai depois de a decisão ficar nas ações do admin (registro antes da resposta e da auditoria)', async () => {
      moderation.act.mockResolvedValue({ result, target });
      let release: () => void = () => undefined;
      recordAction.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      let answered = false;
      const pending = request(adminApp)
        .post('/api/admin/reports/12/remove-image')
        .set(ADMIN)
        .then((res) => {
          answered = true;
          return res;
        });

      await vi.waitFor(() => expect(recordAction).toHaveBeenCalledTimes(1));
      expect(answered).toBe(false);
      expect(audit).not.toHaveBeenCalled();

      release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
      expect(audit).toHaveBeenCalledTimes(1);
    });

    it('a decisão da moderação vem antes do registro: o que fica nas ações do admin é o alvo que ela devolveu', async () => {
      // O alvo registrado sai da denúncia lida pela moderação, não da URL (12 é o id da denúncia).
      moderation.act.mockResolvedValue({
        result,
        target: { type: 'message', id: 55, imageUrl: null },
      });

      await request(adminApp)
        .post('/api/admin/reports/12/remove-content')
        .set(ADMIN)
        .send({ note: 'Pagamento por fora.' })
        .expect(200);

      expect(moderation.act.mock.invocationCallOrder[0]!).toBeLessThan(
        recordAction.mock.invocationCallOrder[0]!,
      );
      expect(recordAction).toHaveBeenCalledWith(
        1,
        'content_removed',
        'message',
        55,
        'Pagamento por fora.',
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'content_removed',
          entityType: 'message',
          entityId: 55,
          newValue: { reportId: 12, imageUrl: null, note: 'Pagamento por fora.', ...result },
        }),
      );
    });

    it('decisão já gravada cujo registro nas ações do admin falha: 200 com a decisão, a auditoria ainda grava e a falha vai para o log e o Sentry', async () => {
      moderation.act.mockResolvedValue({ result, target });
      const boom = new Error('banco fora');
      recordAction.mockRejectedValueOnce(boom);
      const error = vi.spyOn(logger, 'error');

      try {
        const res = await request(adminApp)
          .post('/api/admin/reports/12/remove-image')
          .set(ADMIN)
          .send({ note: 'Imagem ofensiva.' })
          .expect(200);

        // A nova tentativa daria 409 (já analisada): a resposta tem de ser a decisão, não um 500.
        expect(res.body).toEqual(result);
        expect(audit).toHaveBeenCalledTimes(1);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'image_removed', entityType: 'avatar', entityId: 9 }),
        );
        expect(error).toHaveBeenCalledWith(
          { err: boom, adminId: 1, reportId: 12, action: 'image_removed' },
          'decisão sem registro nas ações do admin',
        );
        expect(captureError).toHaveBeenCalledWith(boom);
      } finally {
        error.mockRestore();
      }
    });

    it('decisão que a moderação recusa (já analisada) não fica registrada como ação do admin', async () => {
      moderation.act.mockRejectedValue(
        new HttpError(409, 'Estas denúncias já foram analisadas', 'report_already_resolved'),
      );
      const res = await request(adminApp)
        .post('/api/admin/reports/12/resolve')
        .set(ADMIN)
        .send({ note: 'Resolvido.' })
        .expect(409);
      expect(res.body).toEqual({
        error: 'report_already_resolved',
        message: 'Estas denúncias já foram analisadas',
      });
      expect(recordAction).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });
});
