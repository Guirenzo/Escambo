import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { adminRoutes } from '../admin/admin.routes';
import { moderationRoutes } from './appeals.routes';

const { service, recordAction, audit } = vi.hoisted(() => ({
  service: {
    mine: vi.fn(),
    appeal: vi.fn(),
    listForAdmin: vi.fn(),
    quarantineImage: vi.fn(),
    decide: vi.fn(),
  },
  recordAction: vi.fn(),
  audit: vi.fn(),
}));
// O mínimo de caracteres da contestação (APPEAL_MIN_CHARS) continua vindo do módulo de verdade.
vi.mock('./appeals.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./appeals.service')>()),
  appealsService: service,
}));
vi.mock('../admin/admin.repository', () => ({ adminRepository: { recordAction } }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: audit } }));

const ownerApp = routerApp('/api/moderation', moderationRoutes);
// As rotas do admin são as de verdade (admin.routes.ts), para o 403 vir do requireAdmin real.
const adminApp = routerApp('/api/admin', adminRoutes);

const ADMIN = bearer(1, 'admin');
const LONG_ENOUGH = 'Essa foto é minha, tirada por mim.';
const LOCAL_IP = expect.stringMatching(/127\.0\.0\.1$|^::1$/);

beforeEach(() => vi.resetAllMocks());

/** Moderação vista pelo dono (ADR 41): só logado, e sempre em nome de quem está logado. */
describe('contestação pelo dono: borda HTTP', () => {
  describe('GET /api/moderation/removals', () => {
    it('exige login', async () => {
      const res = await request(ownerApp).get('/api/moderation/removals');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.mine).not.toHaveBeenCalled();
    });

    it('devolve as remoções e a reincidência de quem está logado', async () => {
      const mine = { removals: [{ id: 31, canAppeal: true }], strikes: { strikes: 1 } };
      service.mine.mockResolvedValue(mine);
      const res = await request(ownerApp)
        .get('/api/moderation/removals')
        .set(bearer(9))
        .expect(200);
      expect(res.body).toEqual(mine);
      expect(service.mine).toHaveBeenCalledTimes(1);
      expect(service.mine).toHaveBeenCalledWith(9);
    });
  });

  describe('POST /api/moderation/removals/:id/appeal', () => {
    it('exige login', async () => {
      const res = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .send({ text: LONG_ENOUGH });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.appeal).not.toHaveBeenCalled();
    });

    it('quem contesta é sempre quem está logado: dono mandado no corpo ou na URL é ignorado', async () => {
      service.appeal.mockResolvedValue({ id: 31, status: 'appealed' });
      await request(ownerApp)
        .post('/api/moderation/removals/31/appeal?ownerId=1')
        .set(bearer(12, 'freelancer'))
        .send({ text: LONG_ENOUGH, ownerId: 1, uid: 1 })
        .expect(200);
      expect(service.appeal).toHaveBeenCalledTimes(1);
      expect(service.appeal).toHaveBeenCalledWith(12, 31, LONG_ENOUGH);
    });

    it('remoção de outra pessoa: o 404 do service chega como está, sem dizer que ela existe', async () => {
      service.appeal.mockRejectedValue(
        new HttpError(404, 'Remoção não encontrada', 'removal_not_found'),
      );
      const res = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({ text: LONG_ENOUGH })
        .expect(404);
      expect(res.body).toEqual({ error: 'removal_not_found', message: 'Remoção não encontrada' });
    });

    it('contesta em nome de quem está logado, com o id convertido e o texto sem espaços nas pontas', async () => {
      service.appeal.mockResolvedValue({ id: 31, status: 'appealed', canAppeal: false });
      const res = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({ text: `  ${LONG_ENOUGH}  ` })
        .expect(200);
      expect(res.body).toEqual({ id: 31, status: 'appealed', canAppeal: false });
      expect(service.appeal).toHaveBeenCalledTimes(1);
      expect(service.appeal).toHaveBeenCalledWith(9, 31, LONG_ENOUGH);
    });

    it('a explicação tem de 20 a 1000 caracteres, contados sem os espaços das pontas', async () => {
      const short = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        // 19 letras cercadas de espaço: o espaço não ajuda a chegar ao mínimo.
        .send({ text: `   ${'a'.repeat(19)}   ` })
        .expect(422);
      expect(short.body.error).toBe('validation_error');
      expect(short.body.details.text).toEqual(['Explique em pelo menos 20 caracteres']);

      const long = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({ text: 'a'.repeat(1001) })
        .expect(422);
      expect(long.body.details).toHaveProperty('text');

      const missing = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({})
        .expect(422);
      expect(missing.body.details).toHaveProperty('text');
      expect(service.appeal).not.toHaveBeenCalled();

      service.appeal.mockResolvedValue({ id: 31 });
      await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({ text: 'a'.repeat(20) })
        .expect(200);
      await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({ text: 'a'.repeat(1000) })
        .expect(200);
      expect(service.appeal).toHaveBeenCalledTimes(2);
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(ownerApp)
          .post(`/api/moderation/removals/${id}/appeal`)
          .set(bearer(9))
          .send({ text: LONG_ENOUGH })
          .expect(422);
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.appeal).not.toHaveBeenCalled();
    });

    it('a recusa do service (prazo vencido) vira a resposta com o código dele', async () => {
      service.appeal.mockRejectedValue(
        new HttpError(410, 'O prazo para contestar esta remoção terminou', 'appeal_window_closed'),
      );
      const res = await request(ownerApp)
        .post('/api/moderation/removals/31/appeal')
        .set(bearer(9))
        .send({ text: LONG_ENOUGH })
        .expect(410);
      expect(res.body).toEqual({
        error: 'appeal_window_closed',
        message: 'O prazo para contestar esta remoção terminou',
      });
    });
  });
});

/** Contestações na mão do admin (ADR 41): listar, ver a imagem em quarentena e decidir. */
describe('contestação pelo admin: borda HTTP', () => {
  describe('quem pode chamar', () => {
    const routes: ['get' | 'post', string][] = [
      ['get', '/api/admin/appeals'],
      ['get', '/api/admin/appeals/31/image'],
      ['post', '/api/admin/appeals/31/uphold'],
      ['post', '/api/admin/appeals/31/overturn'],
    ];

    it('sem login é 401', async () => {
      for (const [method, url] of routes) {
        const res = await request(adminApp)[method](url);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('missing_token');
      }
    });

    it('logado sem ser admin é 403, e nada chega ao service nem às ações do admin', async () => {
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
      expect(service.listForAdmin).not.toHaveBeenCalled();
      expect(service.quarantineImage).not.toHaveBeenCalled();
      expect(service.decide).not.toHaveBeenCalled();
      expect(recordAction).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/appeals', () => {
    it('sem filtro lista as pendentes; ?status=decided, as decididas', async () => {
      service.listForAdmin.mockResolvedValue([{ id: 31 }]);

      const pending = await request(adminApp).get('/api/admin/appeals').set(ADMIN).expect(200);
      expect(pending.body).toEqual([{ id: 31 }]);
      expect(service.listForAdmin).toHaveBeenLastCalledWith('pending');

      await request(adminApp).get('/api/admin/appeals?status=decided').set(ADMIN).expect(200);
      expect(service.listForAdmin).toHaveBeenLastCalledWith('decided');
      expect(service.listForAdmin).toHaveBeenCalledTimes(2);
    });

    it('filtro desconhecido é erro de validação', async () => {
      const res = await request(adminApp)
        .get('/api/admin/appeals?status=upheld')
        .set(ADMIN)
        .expect(422);
      expect(res.body.details).toHaveProperty('status');
      expect(service.listForAdmin).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/appeals/:id/image', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'escambo-appeals-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('entrega o arquivo da quarentena com o tipo da extensão, sem cache e sem sniffing', async () => {
      const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]);
      const file = path.join(dir, '31.webp');
      await writeFile(file, bytes);
      service.quarantineImage.mockResolvedValue(file);

      const res = await request(adminApp)
        .get('/api/admin/appeals/31/image')
        .set(ADMIN)
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(service.quarantineImage).toHaveBeenCalledTimes(1);
      expect(service.quarantineImage).toHaveBeenCalledWith(31);
      expect(res.headers['content-type']).toBe('image/webp');
      // Imagem removida não pode ficar em cache de proxy nem do navegador.
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
    });

    it('cada extensão de imagem sai com o seu tipo; extensão desconhecida sai como binário', async () => {
      const expected: [string, string][] = [
        ['31.jpg', 'image/jpeg'],
        ['31.png', 'image/png'],
        ['31.gif', 'image/gif'],
        ['31.bin', 'application/octet-stream'],
      ];
      for (const [name, type] of expected) {
        const file = path.join(dir, name);
        await writeFile(file, 'x');
        service.quarantineImage.mockResolvedValueOnce(file);
        const res = await request(adminApp)
          .get('/api/admin/appeals/31/image')
          .set(ADMIN)
          .expect(200);
        expect(res.headers['content-type']).toBe(type);
      }
    });

    it('arquivo que já saiu do disco é 404 padronizado, não erro interno', async () => {
      service.quarantineImage.mockResolvedValue(path.join(dir, '31.webp'));
      const res = await request(adminApp).get('/api/admin/appeals/31/image').set(ADMIN).expect(404);
      expect(res.body).toEqual({
        error: 'removal_image_not_found',
        message: 'Imagem não disponível',
      });
    });

    it('arquivo oculto (nome começando com ponto) não é servido', async () => {
      const file = path.join(dir, '.oculto.webp');
      await writeFile(file, 'x');
      service.quarantineImage.mockResolvedValue(file);
      const res = await request(adminApp).get('/api/admin/appeals/31/image').set(ADMIN).expect(404);
      expect(res.body.error).toBe('removal_image_not_found');
    });

    it('remoção sem imagem em quarentena: o 404 do service chega como está', async () => {
      service.quarantineImage.mockRejectedValue(
        new HttpError(404, 'Imagem não disponível', 'removal_image_not_found'),
      );
      const res = await request(adminApp).get('/api/admin/appeals/31/image').set(ADMIN).expect(404);
      expect(res.body.error).toBe('removal_image_not_found');
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(adminApp)
          .get(`/api/admin/appeals/${id}/image`)
          .set(ADMIN)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.quarantineImage).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/appeals/:id/uphold|overturn', () => {
    const upheld = {
      status: 'upheld',
      restoredReferences: 0,
      imageRestored: false,
      contentRestored: false,
      fileDeleted: true,
    };
    const overturned = {
      status: 'overturned',
      restoredReferences: 1,
      imageRestored: true,
      contentRestored: true,
      fileDeleted: false,
    };

    it('manter: decide em nome do admin logado, registra nas ações do admin e na auditoria, com a nota', async () => {
      service.decide.mockResolvedValue(upheld);

      const res = await request(adminApp)
        .post('/api/admin/appeals/31/uphold')
        .set(ADMIN)
        .set('User-Agent', 'vitest-agent')
        .send({ note: '  Continua ofensiva.  ' })
        .expect(200);

      expect(res.body).toEqual(upheld);
      expect(service.decide).toHaveBeenCalledTimes(1);
      expect(service.decide).toHaveBeenCalledWith(1, 31, 'uphold', 'Continua ofensiva.');
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction).toHaveBeenCalledWith(
        1,
        'appeal_upheld',
        'image_removal',
        31,
        'Continua ofensiva.',
      );
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: 1,
        action: 'appeal_upheld',
        entityType: 'image_removal',
        entityId: 31,
        newValue: { note: 'Continua ofensiva.', ...upheld },
        ip: LOCAL_IP,
        userAgent: 'vitest-agent',
      });
    });

    it('reverter fica registrado como appeal_overturned; sem corpo, nota em branco ou nula vale como sem nota', async () => {
      service.decide.mockResolvedValue(overturned);

      const bodies: (Record<string, unknown> | undefined)[] = [
        undefined,
        {},
        { note: '   ' },
        { note: null },
      ];
      for (const body of bodies) {
        vi.clearAllMocks();
        service.decide.mockResolvedValue(overturned);
        const req = request(adminApp).post('/api/admin/appeals/44/overturn').set(ADMIN);
        const res = await (body === undefined ? req : req.send(body)).expect(200);

        expect(res.body).toEqual(overturned);
        expect(service.decide).toHaveBeenCalledWith(1, 44, 'overturn', null);
        expect(recordAction).toHaveBeenCalledWith(
          1,
          'appeal_overturned',
          'image_removal',
          44,
          null,
        );
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 1,
            action: 'appeal_overturned',
            entityId: 44,
            newValue: { note: null, ...overturned },
          }),
        );
      }
    });

    it('decisão desconhecida, id inválido ou nota acima de 500 caracteres é erro de validação', async () => {
      const unknown = await request(adminApp)
        .post('/api/admin/appeals/31/delete')
        .set(ADMIN)
        .expect(422);
      expect(unknown.body.details).toHaveProperty('decision');

      for (const id of ['abc', '0', '-3', '1.5']) {
        const badId = await request(adminApp)
          .post(`/api/admin/appeals/${id}/uphold`)
          .set(ADMIN)
          .expect(422);
        expect(badId.body.error).toBe('validation_error');
        expect(badId.body.details).toHaveProperty('id');
      }

      const longNote = await request(adminApp)
        .post('/api/admin/appeals/31/uphold')
        .set(ADMIN)
        .send({ note: 'x'.repeat(501) })
        .expect(422);
      expect(longNote.body.details).toHaveProperty('note');

      expect(service.decide).not.toHaveBeenCalled();
      expect(recordAction).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();

      // No limite, a nota de 500 caracteres passa e chega inteira ao service.
      service.decide.mockResolvedValue(upheld);
      await request(adminApp)
        .post('/api/admin/appeals/31/uphold')
        .set(ADMIN)
        .send({ note: 'x'.repeat(500) })
        .expect(200);
      expect(service.decide).toHaveBeenCalledWith(1, 31, 'uphold', 'x'.repeat(500));
    });

    it('a resposta só sai depois de a decisão ficar nas ações do admin (registro antes da resposta)', async () => {
      service.decide.mockResolvedValue(upheld);
      let release: () => void = () => undefined;
      recordAction.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      let answered = false;
      const pending = request(adminApp)
        .post('/api/admin/appeals/31/uphold')
        .set(ADMIN)
        .then((res) => {
          answered = true;
          return res;
        });

      await vi.waitFor(() => expect(recordAction).toHaveBeenCalledTimes(1));
      // O registro ainda não terminou: nem resposta, nem trilha de auditoria.
      expect(answered).toBe(false);
      expect(audit).not.toHaveBeenCalled();

      release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toEqual(upheld);
      expect(audit).toHaveBeenCalledTimes(1);
    });

    it('decisão que o service recusa (já decidida) não fica registrada como ação do admin', async () => {
      service.decide.mockRejectedValue(
        new HttpError(409, 'Esta contestação não está esperando decisão', 'appeal_not_pending'),
      );
      const res = await request(adminApp)
        .post('/api/admin/appeals/31/overturn')
        .set(ADMIN)
        .send({ note: 'Foto legítima.' })
        .expect(409);
      expect(res.body).toEqual({
        error: 'appeal_not_pending',
        message: 'Esta contestação não está esperando decisão',
      });
      expect(recordAction).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });
});
