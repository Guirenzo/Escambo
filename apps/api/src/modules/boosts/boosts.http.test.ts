import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { boostsRoutes } from './boosts.routes';

const { service } = vi.hoisted(() => ({
  service: { plans: vi.fn(), buy: vi.fn(), listMine: vi.fn() },
}));
vi.mock('./boosts.service', () => ({ boostsService: service }));

const app = routerApp('/api/boosts', boostsRoutes);

const boost = {
  id: 91,
  serviceId: 3,
  planId: 2,
  planName: 'Destaque 7 dias',
  status: 'active',
  startsAt: '2026-03-10T12:00:00.000Z',
  expiresAt: '2026-03-17T12:00:00.000Z',
  createdAt: '2026-03-10T12:00:00.000Z',
};

/** Rotas e controllers do impulsionamento: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('impulsionamentos: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('todas as rotas exigem login', () => {
    it('sem token, nenhuma das três responde e o service não é chamado', async () => {
      const calls = [
        request(app).get('/api/boosts/plans'),
        request(app).get('/api/boosts'),
        request(app).post('/api/boosts').send({ serviceId: 3, planId: 2 }),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('missing_token');
      }
      expect(service.plans).not.toHaveBeenCalled();
      expect(service.listMine).not.toHaveBeenCalled();
      expect(service.buy).not.toHaveBeenCalled();
    });

    it('token que não foi assinado pela API é recusado', async () => {
      const res = await request(app)
        .post('/api/boosts')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .send({ serviceId: 3, planId: 2 });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.buy).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/boosts/plans', () => {
    it('devolve os planos que o service entrega', async () => {
      const plans = [
        {
          id: 1,
          name: 'Destaque 7 dias',
          description: null,
          durationDays: 7,
          price: 29.9,
          costCredits: 30,
          features: { top_search: true },
        },
      ];
      service.plans.mockResolvedValue(plans);

      const res = await request(app).get('/api/boosts/plans').set(bearer(7)).expect(200);

      expect(res.body).toEqual(plans);
      expect(service.plans).toHaveBeenCalledTimes(1);
      expect(service.plans).toHaveBeenCalledWith();
      // "/plans" não pode cair na lista de impulsionamentos de quem chamou.
      expect(service.listMine).not.toHaveBeenCalled();
    });

    it('sem plano ativo, responde 200 com a lista vazia', async () => {
      service.plans.mockResolvedValue([]);
      const res = await request(app).get('/api/boosts/plans').set(bearer(7)).expect(200);
      expect(res.body).toEqual([]);
    });

    it('falha do service ao listar os planos vira 500 padronizado, sem vazar o motivo (RNF-039)', async () => {
      service.plans.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3306'));
      const res = await request(app).get('/api/boosts/plans').set(bearer(7)).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('GET /api/boosts', () => {
    it('lista só os impulsionamentos de quem está logado', async () => {
      service.listMine.mockResolvedValue([boost]);

      const res = await request(app).get('/api/boosts').set(bearer(7)).expect(200);

      expect(res.body).toEqual([boost]);
      expect(service.listMine).toHaveBeenCalledTimes(1);
      expect(service.listMine).toHaveBeenCalledWith(7);
    });

    it('o dono da lista vem do token, não da query string', async () => {
      service.listMine.mockResolvedValue([]);
      const res = await request(app).get('/api/boosts?userId=99').set(bearer(8)).expect(200);
      expect(res.body).toEqual([]);
      expect(service.listMine).toHaveBeenCalledTimes(1);
      expect(service.listMine).toHaveBeenCalledWith(8);
      // A lista de quem chamou não pode ser atendida pela rota dos planos.
      expect(service.plans).not.toHaveBeenCalled();
    });

    it('falha do service ao listar vira 500 padronizado, sem vazar o motivo (RNF-039)', async () => {
      service.listMine.mockRejectedValue(new Error('ER_BAD_FIELD_ERROR: b.plan_id'));
      const res = await request(app).get('/api/boosts').set(bearer(7)).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('POST /api/boosts', () => {
    it('compra em nome de quem está logado e responde 201 com o impulsionamento', async () => {
      service.buy.mockResolvedValue(boost);

      const res = await request(app)
        .post('/api/boosts')
        .set(bearer(7))
        .send({ serviceId: 3, planId: 2 })
        .expect(201);

      expect(res.body).toEqual(boost);
      expect(service.buy).toHaveBeenCalledTimes(1);
      expect(service.buy).toHaveBeenCalledWith(7, 3, 2);
    });

    it('o comprador é sempre o do token, mesmo que o corpo traga outro userId', async () => {
      service.buy.mockResolvedValue(boost);
      await request(app)
        .post('/api/boosts')
        .set(bearer(7))
        .send({ serviceId: 3, planId: 2, userId: 99 })
        .expect(201);
      expect(service.buy).toHaveBeenCalledWith(7, 3, 2);
    });

    it('serviceId e planId precisam ser inteiros positivos (número, não texto)', async () => {
      const invalid: Array<[Record<string, unknown>, string]> = [
        [{ planId: 2 }, 'serviceId'],
        [{ serviceId: 3 }, 'planId'],
        [{ serviceId: '3', planId: 2 }, 'serviceId'],
        [{ serviceId: 0, planId: 2 }, 'serviceId'],
        [{ serviceId: 3, planId: -1 }, 'planId'],
        [{ serviceId: 3, planId: 1.5 }, 'planId'],
      ];
      for (const [body, field] of invalid) {
        const res = await request(app).post('/api/boosts').set(bearer(7)).send(body);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty(field);
      }
      expect(service.buy).not.toHaveBeenCalled();
    });

    it('corpo vazio é recusado apontando os dois campos, e nada é comprado', async () => {
      const res = await request(app).post('/api/boosts').set(bearer(7)).send({}).expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details).sort()).toEqual(['planId', 'serviceId']);
      expect(service.buy).not.toHaveBeenCalled();
    });

    it('só o dono impulsiona: a recusa do service para serviço de outra pessoa vira 403', async () => {
      service.buy.mockRejectedValue(
        new HttpError(403, 'Você só pode impulsionar os seus serviços', 'forbidden'),
      );
      const res = await request(app)
        .post('/api/boosts')
        .set(bearer(7))
        .send({ serviceId: 3, planId: 2 })
        .expect(403);
      expect(res.body).toEqual({
        error: 'forbidden',
        message: 'Você só pode impulsionar os seus serviços',
      });
      expect(service.buy).toHaveBeenCalledWith(7, 3, 2);
    });

    it('a recusa do service (créditos insuficientes) vira a resposta com o código dele', async () => {
      service.buy.mockRejectedValue(
        new HttpError(409, 'Créditos insuficientes para impulsionar', 'insufficient_credits'),
      );
      const res = await request(app)
        .post('/api/boosts')
        .set(bearer(7))
        .send({ serviceId: 3, planId: 2 })
        .expect(409);
      expect(res.body).toEqual({
        error: 'insufficient_credits',
        message: 'Créditos insuficientes para impulsionar',
      });
    });

    it('erro inesperado do service vira 500 sem vazar o motivo (RNF-039)', async () => {
      service.buy.mockRejectedValue(new Error('ER_LOCK_DEADLOCK na tabela wallets'));
      const res = await request(app)
        .post('/api/boosts')
        .set(bearer(7))
        .send({ serviceId: 3, planId: 2 })
        .expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });
});
