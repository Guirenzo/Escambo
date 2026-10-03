import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { reviewsRoutes } from './reviews.routes';

const { service, notify } = vi.hoisted(() => ({
  service: { create: vi.fn(), listForFreelancer: vi.fn(), respond: vi.fn() },
  notify: vi.fn(),
}));
vi.mock('./reviews.service', () => ({ reviewsService: service }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify },
}));

const app = routerApp('/api/reviews', reviewsRoutes);

/** Rotas e controllers das avaliações: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('avaliações: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /api/reviews (pública)', () => {
    it('lista sem login, com a paginação padrão e os números convertidos', async () => {
      service.listForFreelancer.mockResolvedValue({ items: [], total: 0 });
      const res = await request(app).get('/api/reviews?freelancerId=12').expect(200);
      expect(res.body).toEqual({ items: [], total: 0 });
      expect(service.listForFreelancer).toHaveBeenCalledWith({
        freelancerId: 12,
        page: 1,
        limit: 20,
      });
    });

    it('sem freelancerId, ou com limite acima de 100, é erro de validação e não chega ao service', async () => {
      const semId = await request(app).get('/api/reviews').expect(422);
      expect(semId.body.error).toBe('validation_error');
      expect(semId.body.details).toHaveProperty('freelancerId');
      await request(app).get('/api/reviews?freelancerId=12&limit=101').expect(422);
      expect(service.listForFreelancer).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/reviews', () => {
    it('exige login', async () => {
      const res = await request(app).post('/api/reviews').send({ contractId: 1, rating: 5 });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('cria em nome de quem está logado e avisa o avaliado', async () => {
      service.create.mockResolvedValue({ id: 9, revieweeId: 44, rating: 5 });
      const res = await request(app)
        .post('/api/reviews')
        .set(bearer(7))
        .send({ contractId: 3, rating: 5, comment: 'Ótimo' })
        .expect(201);

      expect(res.body).toEqual({ id: 9, revieweeId: 44, rating: 5 });
      expect(service.create).toHaveBeenCalledWith(7, {
        contractId: 3,
        rating: 5,
        comment: 'Ótimo',
      });
      expect(notify).toHaveBeenCalledWith(44, {
        type: 'review_received',
        title: 'Você recebeu uma avaliação',
        data: { reviewId: 9, rating: 5 },
      });
    });

    it('nota fora de 1 a 5 é recusada na validação (RF-052)', async () => {
      for (const rating of [0, 6, 4.5]) {
        const res = await request(app)
          .post('/api/reviews')
          .set(bearer(7))
          .send({ contractId: 3, rating })
          .expect(422);
        expect(res.body.details).toHaveProperty('rating');
      }
      expect(service.create).not.toHaveBeenCalled();
    });

    it('a recusa do service vira a resposta com o código dele, e ninguém é avisado', async () => {
      service.create.mockRejectedValue(
        new HttpError(409, 'Contrato já avaliado', 'already_reviewed'),
      );
      const res = await request(app)
        .post('/api/reviews')
        .set(bearer(7))
        .send({ contractId: 3, rating: 4 })
        .expect(409);
      expect(res.body).toEqual({ error: 'already_reviewed', message: 'Contrato já avaliado' });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/reviews/:id/response', () => {
    it('exige login e um id numérico', async () => {
      await request(app).post('/api/reviews/5/response').send({ response: 'Obrigado' }).expect(401);
      await request(app)
        .post('/api/reviews/abc/response')
        .set(bearer(44))
        .send({ response: 'Obrigado' })
        .expect(422);
      expect(service.respond).not.toHaveBeenCalled();
    });

    it('responde em nome de quem está logado', async () => {
      service.respond.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/api/reviews/5/response')
        .set(bearer(44))
        .send({ response: 'Obrigado pela confiança' })
        .expect(201);
      expect(res.body).toEqual({ ok: true });
      expect(service.respond).toHaveBeenCalledWith(5, 44, 'Obrigado pela confiança');
    });

    it('resposta vazia é recusada', async () => {
      await request(app)
        .post('/api/reviews/5/response')
        .set(bearer(44))
        .send({ response: '' })
        .expect(422);
      expect(service.respond).not.toHaveBeenCalled();
    });
  });
});
