import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { openDispute } from './disputes.controller';
import { disputesRoutes } from './disputes.routes';

const { service, auditLog } = vi.hoisted(() => ({
  service: { open: vi.fn(), listMine: vi.fn(), getById: vi.fn() },
  auditLog: vi.fn(),
}));
vi.mock('./disputes.service', () => ({ disputesService: service }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: auditLog } }));

const app = routerApp('/api/disputes', disputesRoutes);

const dispute = {
  id: 31,
  ulid: '01JDISPUTE0000000000000000',
  contractId: 8,
  openedBy: 7,
  reason: 'quality',
  description: 'A entrega veio incompleta',
  status: 'open',
  resolution: null,
  refundPercentage: null,
  createdAt: '2026-10-01T12:00:00.000Z',
};
const body = { contractId: 8, reason: 'quality', description: 'A entrega veio incompleta' };

/** Rotas e controllers das disputas: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('disputas: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('todas as rotas exigem login', async () => {
    for (const res of [
      await request(app).post('/api/disputes').send(body),
      await request(app).get('/api/disputes'),
      await request(app).get('/api/disputes/31'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    const invalid = await request(app)
      .get('/api/disputes')
      .set({ Authorization: 'Bearer nao-e-um-jwt' });
    expect(invalid.status).toBe(401);
    expect(invalid.body.error).toBe('invalid_token');

    expect(service.open).not.toHaveBeenCalled();
    expect(service.listMine).not.toHaveBeenCalled();
    expect(service.getById).not.toHaveBeenCalled();
  });

  describe('conta bloqueada pela moderação (RN-007)', () => {
    afterEach(() => blocklist.delete(7));

    it('conta suspensa ou banida não abre, não lista nem vê disputa, mesmo com token ainda válido', async () => {
      blocklist.add(7);
      for (const res of [
        await request(app).post('/api/disputes').set(bearer(7)).send(body),
        await request(app).get('/api/disputes').set(bearer(7)),
        await request(app).get('/api/disputes/31').set(bearer(7)),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
      expect(service.open).not.toHaveBeenCalled();
      expect(service.listMine).not.toHaveBeenCalled();
      expect(service.getById).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();

      // O bloqueio é da conta, não da rota: outra pessoa continua passando.
      service.listMine.mockResolvedValue([]);
      await request(app).get('/api/disputes').set(bearer(44)).expect(200);
      expect(service.listMine).toHaveBeenCalledWith(44);
    });
  });

  describe('POST /api/disputes', () => {
    it('abre a disputa em nome de quem está logado e devolve 201 com ela', async () => {
      service.open.mockResolvedValue(dispute);

      const res = await request(app).post('/api/disputes').set(bearer(7)).send(body).expect(201);

      expect(res.body).toEqual(dispute);
      expect(service.open).toHaveBeenCalledTimes(1);
      expect(service.open).toHaveBeenCalledWith(7, body);
    });

    it('registra a abertura na auditoria, com quem abriu, a disputa criada e a origem (RN-010)', async () => {
      service.open.mockResolvedValue(dispute);

      await request(app)
        .post('/api/disputes')
        .set(bearer(7))
        .set('User-Agent', 'vitest-agent/1.0')
        .send(body)
        .expect(201);

      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith({
        userId: 7,
        action: 'dispute_opened',
        entityType: 'dispute',
        entityId: 31,
        newValue: { contractId: 8, reason: 'quality' },
        ip: expect.stringMatching(/127\.0\.0\.1|::1/),
        userAgent: 'vitest-agent/1.0',
      });
    });

    it('a resposta não espera a auditoria: o registro é em segundo plano e não segura quem abriu a disputa (RN-010)', async () => {
      service.open.mockResolvedValue(dispute);
      // Gravação da auditoria que nunca termina (banco lento): a disputa já aberta é devolvida mesmo assim.
      auditLog.mockReturnValueOnce(new Promise<void>(() => undefined));

      const res = await request(app).post('/api/disputes').set(bearer(7)).send(body).expect(201);

      expect(res.body).toEqual(dispute);
      expect(auditLog).toHaveBeenCalledTimes(1);
    });

    it('sem User-Agent, a auditoria guarda null no lugar dele', async () => {
      service.open.mockResolvedValue(dispute);
      await request(app)
        .post('/api/disputes')
        .set(bearer(7))
        .unset('User-Agent')
        .send(body)
        .expect(201);
      expect(auditLog.mock.calls[0]![0]).toMatchObject({ userAgent: null });
    });

    it('sem IP conhecido (conexão já encerrada quando o controller roda), a auditoria guarda null', async () => {
      service.open.mockResolvedValue(dispute);
      // Com o supertest o req.ip vem sempre preenchido: aqui o controller é chamado direto.
      const req = { body, headers: {}, user: { sub: 'ulid-7', uid: 7, role: 'client' } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await openDispute(req as unknown as Request, res as unknown as Response);

      expect(auditLog).toHaveBeenCalledWith({
        userId: 7,
        action: 'dispute_opened',
        entityType: 'dispute',
        entityId: 31,
        newValue: { contractId: 8, reason: 'quality' },
        ip: null,
        userAgent: null,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(dispute);
    });

    it('campo fora do contrato da rota (quem abriu, status) não chega ao service', async () => {
      service.open.mockResolvedValue(dispute);
      await request(app)
        .post('/api/disputes')
        .set(bearer(7))
        .send({ ...body, openedBy: 99, status: 'resolved' })
        .expect(201);
      expect(service.open).toHaveBeenCalledWith(7, body);
    });

    it('contratação que não é número inteiro positivo é recusada (texto não é convertido)', async () => {
      for (const contractId of ['8', 0, -1, 1.5, null]) {
        const res = await request(app)
          .post('/api/disputes')
          .set(bearer(7))
          .send({ ...body, contractId })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('contractId');
      }
      expect(service.open).not.toHaveBeenCalled();
    });

    it('corpo vazio ou ausente é recusado apontando os três campos obrigatórios', async () => {
      for (const send of [{}, undefined]) {
        const res = await request(app).post('/api/disputes').set(bearer(7)).send(send).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details).sort()).toEqual([
          'contractId',
          'description',
          'reason',
        ]);
      }
      expect(service.open).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('a descrição precisa ser texto: número ou lista não são convertidos', async () => {
      for (const description of [1234567890, ['a'.repeat(20)], null]) {
        const res = await request(app)
          .post('/api/disputes')
          .set(bearer(7))
          .send({ ...body, description })
          .expect(422);
        expect(res.body.details).toHaveProperty('description');
      }
      expect(service.open).not.toHaveBeenCalled();
    });

    it('o motivo precisa ser um dos previstos', async () => {
      const res = await request(app)
        .post('/api/disputes')
        .set(bearer(7))
        .send({ ...body, reason: 'vinganca' })
        .expect(422);
      expect(res.body.details).toHaveProperty('reason');

      service.open.mockResolvedValue(dispute);
      for (const reason of ['not_delivered', 'quality', 'deadline', 'scope', 'payment', 'other']) {
        await request(app)
          .post('/api/disputes')
          .set(bearer(7))
          .send({ ...body, reason })
          .expect(201);
        expect(service.open).toHaveBeenLastCalledWith(7, { ...body, reason });
      }
    });

    it('a descrição vai de 10 a 2000 caracteres', async () => {
      for (const description of ['curta', 'a'.repeat(9), 'a'.repeat(2001), undefined]) {
        const res = await request(app)
          .post('/api/disputes')
          .set(bearer(7))
          .send({ ...body, description })
          .expect(422);
        expect(res.body.details).toHaveProperty('description');
      }
      expect(service.open).not.toHaveBeenCalled();

      service.open.mockResolvedValue(dispute);
      for (const description of ['a'.repeat(10), 'a'.repeat(2000)]) {
        await request(app)
          .post('/api/disputes')
          .set(bearer(7))
          .send({ ...body, description })
          .expect(201);
        expect(service.open).toHaveBeenLastCalledWith(7, { ...body, description });
      }
    });

    it('a recusa do service vira a resposta com o código dele, e nada vai para a auditoria', async () => {
      service.open.mockRejectedValue(
        new HttpError(
          409,
          'A contratação não está em um estado que permite disputa',
          'not_disputable',
        ),
      );
      const res = await request(app).post('/api/disputes').set(bearer(7)).send(body).expect(409);
      expect(res.body).toEqual({
        error: 'not_disputable',
        message: 'A contratação não está em um estado que permite disputa',
      });
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('validação recusada também não vai para a auditoria', async () => {
      await request(app)
        .post('/api/disputes')
        .set(bearer(7))
        .send({ ...body, reason: 'x' })
        .expect(422);
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/disputes', () => {
    it('lista as disputas de quem está logado', async () => {
      service.listMine.mockResolvedValue([dispute]);
      const res = await request(app).get('/api/disputes').set(bearer(44)).expect(200);
      expect(res.body).toEqual([dispute]);
      expect(service.listMine).toHaveBeenCalledTimes(1);
      expect(service.listMine).toHaveBeenCalledWith(44);
    });

    it('um filtro de usuário na URL não troca de quem é a lista; sem disputas, devolve lista vazia', async () => {
      service.listMine.mockResolvedValue([]);
      const res = await request(app).get('/api/disputes?userId=7').set(bearer(44)).expect(200);
      expect(res.body).toEqual([]);
      // Um argumento só: nada da URL chega ao service.
      expect(service.listMine.mock.calls).toEqual([[44]]);
    });

    it('listar e ver disputa não são ações auditadas: só a abertura é', async () => {
      service.listMine.mockResolvedValue([dispute]);
      service.getById.mockResolvedValue(dispute);
      await request(app).get('/api/disputes').set(bearer(44)).expect(200);
      await request(app).get('/api/disputes/31').set(bearer(44)).expect(200);
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/disputes/:id', () => {
    it('busca a disputa pelo id convertido em número, em nome de quem está logado', async () => {
      service.getById.mockResolvedValue(dispute);
      const res = await request(app).get('/api/disputes/31').set(bearer(44)).expect(200);
      expect(res.body).toEqual(dispute);
      expect(service.getById).toHaveBeenCalledTimes(1);
      expect(service.getById).toHaveBeenCalledWith(31, 44);
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app).get(`/api/disputes/${id}`).set(bearer(44)).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('quem não participa recebe o 403 do service; disputa inexistente, o 404', async () => {
      service.getById.mockRejectedValueOnce(
        new HttpError(403, 'Você não participa desta disputa', 'forbidden'),
      );
      const forbidden = await request(app).get('/api/disputes/31').set(bearer(99)).expect(403);
      expect(forbidden.body).toEqual({
        error: 'forbidden',
        message: 'Você não participa desta disputa',
      });

      service.getById.mockRejectedValueOnce(
        new HttpError(404, 'Disputa não encontrada', 'dispute_not_found'),
      );
      const missing = await request(app).get('/api/disputes/999').set(bearer(99)).expect(404);
      expect(missing.body.error).toBe('dispute_not_found');
      // O service decide com o id pedido e com quem está logado, nas duas recusas.
      expect(service.getById).toHaveBeenNthCalledWith(1, 31, 99);
      expect(service.getById).toHaveBeenNthCalledWith(2, 999, 99);
    });
  });

  it('as partes não editam nem apagam disputa: só abrir, listar e ver (quem decide é a mediação)', async () => {
    for (const res of [
      await request(app).put('/api/disputes/31').set(bearer(7)).send(body),
      await request(app).patch('/api/disputes/31').set(bearer(7)).send({ status: 'resolved' }),
      await request(app).delete('/api/disputes/31').set(bearer(7)),
      await request(app).post('/api/disputes/31/resolve').set(bearer(7)).send({}),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    expect(service.open).not.toHaveBeenCalled();
    expect(service.getById).not.toHaveBeenCalled();
  });

  it('falha inesperada do service vira 500 genérico, sem vazar a mensagem interna', async () => {
    service.listMine.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3306'));
    const res = await request(app).get('/api/disputes').set(bearer(7)).expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
  });
});
