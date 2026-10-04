import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { servicesRoutes } from './services.routes';

const { service } = vi.hoisted(() => ({
  service: {
    create: vi.fn(),
    list: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock('./services.service', () => ({ servicesService: service }));

const app = routerApp('/api/services', servicesRoutes);

/** O que o service devolveria: o corpo da resposta tem de ser exatamente isto. */
const landing = {
  id: 5,
  categoryId: 10,
  ownerId: 7,
  title: 'Landing page',
  description: 'Faço sua landing page responsiva',
  priceType: 'fixed',
  price: 500,
  deliveryDays: 7,
  isRemote: true,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const validBody = {
  categoryId: 10,
  title: 'Landing page',
  description: 'Faço sua landing page responsiva',
  price: 500,
};

/**
 * Rotas, controllers e schemas dos serviços: a descoberta (lista e detalhe) é pública; criar,
 * editar e remover exigem login e agem em nome de quem está logado. O que a validação recusa não
 * chega ao service.
 */
describe('serviços: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /api/services (pública)', () => {
    it('lista sem login, com raio de 25 km, relevância e a primeira página de 20 como padrão', async () => {
      const page = { items: [landing], page: 1, limit: 20 };
      service.list.mockResolvedValue(page);

      const res = await request(app).get('/api/services').expect(200);

      expect(res.body).toEqual(page);
      expect(service.list).toHaveBeenCalledTimes(1);
      expect(service.list.mock.calls[0]).toEqual([
        { radiusKm: 25, sort: 'relevance', page: 1, limit: 20 },
      ]);
    });

    it('cada filtro da busca chega ao service convertido: números, booleanos e o texto sem espaços nas pontas', async () => {
      service.list.mockResolvedValue({ items: [], page: 2, limit: 50 });

      await request(app)
        .get('/api/services')
        .query({
          categoryId: '3',
          ownerId: '9',
          q: '  logo  ',
          isRemote: 'true',
          lat: '-26.3',
          lng: '-48.85',
          radiusKm: '10',
          minPrice: '0',
          maxPrice: '500.5',
          maxDeliveryDays: '7',
          minRating: '4.5',
          day: '6',
          period: 'morning',
          now: 'true',
          sort: 'price_asc',
          page: '2',
          limit: '50',
        })
        .expect(200);

      expect(service.list.mock.calls[0]).toEqual([
        {
          categoryId: 3,
          ownerId: 9,
          q: 'logo',
          isRemote: true,
          lat: -26.3,
          lng: -48.85,
          radiusKm: 10,
          minPrice: 0,
          maxPrice: 500.5,
          maxDeliveryDays: 7,
          minRating: 4.5,
          day: 6,
          period: 'morning',
          now: true,
          sort: 'price_asc',
          page: 2,
          limit: 50,
        },
      ]);
    });

    it('isRemote=false e now=false viram false de verdade (e não "false", que é verdadeiro)', async () => {
      service.list.mockResolvedValue({ items: [], page: 1, limit: 20 });
      await request(app).get('/api/services?isRemote=false&now=false').expect(200);
      expect(service.list.mock.calls[0]).toEqual([
        { isRemote: false, now: false, radiusKm: 25, sort: 'relevance', page: 1, limit: 20 },
      ]);
    });

    it('número vazio na URL vale como ausente: ?lat=&lng= não vira busca em (0, 0), ?minPrice= não vira 0, ?day= não vira domingo', async () => {
      service.list.mockResolvedValue({ items: [], page: 1, limit: 20 });
      const empty = [
        'categoryId',
        'ownerId',
        'lat',
        'lng',
        'radiusKm',
        'minPrice',
        'maxPrice',
        'maxDeliveryDays',
        'minRating',
        'day',
        'page',
        'limit',
      ];

      await request(app)
        .get(`/api/services?${empty.map((k) => `${k}=`).join('&')}`)
        .expect(200);
      // Só espaços também é vazio.
      await request(app).get('/api/services?lat=%20&lng=%20%20&minPrice=%20').expect(200);

      // Nenhum filtro chega ao service; raio, página e limite ficam no padrão.
      expect(service.list.mock.calls).toEqual([
        [{ radiusKm: 25, sort: 'relevance', page: 1, limit: 20 }],
        [{ radiusKm: 25, sort: 'relevance', page: 1, limit: 20 }],
      ]);
    });

    it('domingo (day=0) e os extremos válidos são aceitos: limite 100, raio 500, nota 0 e 5, lat/lng nas bordas', async () => {
      service.list.mockResolvedValue({ items: [], page: 1, limit: 100 });
      await request(app)
        .get('/api/services?day=0&limit=100&radiusKm=500&minRating=5&lat=-90&lng=180')
        .expect(200);
      expect(service.list.mock.calls[0]).toEqual([
        {
          day: 0,
          limit: 100,
          radiusKm: 500,
          minRating: 5,
          lat: -90,
          lng: 180,
          sort: 'relevance',
          page: 1,
        },
      ]);

      // O outro lado de cada faixa: sábado, nota 0, lat máxima, lng mínima, limite 1.
      await request(app).get('/api/services?day=6&limit=1&minRating=0&lat=90&lng=-180').expect(200);
      expect(service.list.mock.calls[1]).toEqual([
        {
          day: 6,
          limit: 1,
          minRating: 0,
          lat: 90,
          lng: -180,
          radiusKm: 25,
          sort: 'relevance',
          page: 1,
        },
      ]);
    });

    it.each(['morning', 'afternoon', 'evening'])(
      'aceita o período %s junto com o dia (ADR 34)',
      async (period) => {
        service.list.mockResolvedValue({ items: [], page: 1, limit: 20 });
        await request(app).get(`/api/services?day=2&period=${period}`).expect(200);
        expect(service.list.mock.calls[0]).toEqual([
          { day: 2, period, radiusKm: 25, sort: 'relevance', page: 1, limit: 20 },
        ]);
      },
    );

    it('parâmetro fora da lista é descartado: os filtros internos da busca não se controlam pela URL', async () => {
      service.list.mockResolvedValue({ items: [], page: 1, limit: 20 });
      await request(app)
        .get('/api/services')
        // excludeOwnerId, createdFrom/createdBefore e offset existem no repository (alertas de
        // busca salva, ADR 35), mas não são da busca pública.
        .query({
          excludeOwnerId: '9',
          createdFrom: '2026-01-01',
          createdBefore: '2026-02-01',
          offset: '40',
          isActive: 'false',
        })
        .expect(200);
      expect(service.list.mock.calls[0]).toEqual([
        { radiusKm: 25, sort: 'relevance', page: 1, limit: 20 },
      ]);
    });

    it.each(['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'distance'])(
      'aceita a ordenação %s',
      async (sort) => {
        service.list.mockResolvedValue({ items: [], page: 1, limit: 20 });
        await request(app).get(`/api/services?sort=${sort}`).expect(200);
        expect(service.list.mock.calls[0]).toEqual([{ radiusKm: 25, sort, page: 1, limit: 20 }]);
      },
    );

    it.each([
      ['categoryId', 'abc'],
      ['categoryId', '0'],
      ['categoryId', '2.5'],
      ['ownerId', '-2'],
      ['ownerId', '1.5'],
      ['ownerId', 'abc'],
      ['q', '   '], // só espaços: depois do trim não sobra texto
      ['isRemote', 'yes'],
      ['isRemote', '1'],
      ['lat', '90.1'],
      ['lat', '-91'],
      ['lng', '180.5'],
      ['lng', '-181'],
      ['lat', 'norte'],
      ['lng', 'leste'],
      ['radiusKm', '0'],
      ['radiusKm', '-5'],
      ['radiusKm', '501'],
      ['minPrice', '-1'],
      ['minPrice', 'barato'],
      ['maxPrice', '0'],
      ['maxPrice', '-10'],
      ['maxDeliveryDays', '0'],
      ['maxDeliveryDays', '2.5'],
      ['minRating', '5.1'],
      ['minRating', '-0.5'],
      ['day', '7'],
      ['day', '-1'],
      ['day', '1.5'],
      ['period', 'night'],
      ['now', 'sim'],
      ['sort', 'cheapest'],
      ['page', '0'],
      ['page', 'x'],
      ['page', '1.5'],
      ['limit', '0'],
      ['limit', '10.5'],
      ['limit', '101'],
    ])('%s=%s é erro de validação e não chega ao service', async (field, value) => {
      const res = await request(app)
        .get('/api/services')
        .query({ [field]: value })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details)).toEqual([field]);
      expect(service.list).not.toHaveBeenCalled();
    });

    it('a recusa do service (período sem dia) vira a resposta com o código dele', async () => {
      service.list.mockRejectedValue(
        new HttpError(422, 'Escolha o dia para filtrar por período', 'period_requires_day'),
      );
      const res = await request(app).get('/api/services?period=evening').expect(422);
      expect(res.body).toEqual({
        error: 'period_requires_day',
        message: 'Escolha o dia para filtrar por período',
      });
    });
  });

  describe('GET /api/services/:id (pública)', () => {
    it('devolve o serviço sem login, com o id convertido para número', async () => {
      service.getById.mockResolvedValue(landing);
      const res = await request(app).get('/api/services/5').expect(200);
      expect(res.body).toEqual(landing);
      expect(service.getById).toHaveBeenCalledTimes(1);
      expect(service.getById).toHaveBeenCalledWith(5);
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-4', '1.5']) {
        const res = await request(app).get(`/api/services/${id}`).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('serviço inexistente: o 404 do service chega como service_not_found', async () => {
      service.getById.mockRejectedValue(
        new HttpError(404, 'Serviço não encontrado', 'service_not_found'),
      );
      const res = await request(app).get('/api/services/999').expect(404);
      expect(res.body).toEqual({ error: 'service_not_found', message: 'Serviço não encontrado' });
      expect(service.getById.mock.calls).toEqual([[999]]);
    });

    it('a descoberta é pública de verdade: lista e detalhe respondem mesmo com um token inválido', async () => {
      const bad = { Authorization: 'Bearer nao-e-um-jwt' };
      service.getById.mockResolvedValue(landing);
      service.list.mockResolvedValue({ items: [landing], page: 1, limit: 20 });

      const detail = await request(app).get('/api/services/5').set(bad).expect(200);
      expect(detail.body).toEqual(landing);
      const list = await request(app).get('/api/services').set(bad).expect(200);
      expect(list.body).toEqual({ items: [landing], page: 1, limit: 20 });
    });
  });

  describe('POST /api/services', () => {
    it('exige login', async () => {
      const res = await request(app).post('/api/services').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.create).not.toHaveBeenCalled();
    });

    it('cria em nome de quem está logado, com preço fixo e presencial como padrão, e responde 201', async () => {
      service.create.mockResolvedValue(landing);

      const res = await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send(validBody)
        .expect(201);

      expect(res.body).toEqual(landing);
      expect(service.create).toHaveBeenCalledTimes(1);
      expect(service.create.mock.calls[0]).toEqual([
        7,
        {
          categoryId: 10,
          title: 'Landing page',
          description: 'Faço sua landing page responsiva',
          priceType: 'fixed',
          price: 500,
          isRemote: false,
        },
      ]);
    });

    it('repassa o que foi informado (por hora, prazo, remoto) e descarta o que não é do cadastro', async () => {
      service.create.mockResolvedValue(landing);

      await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({
          ...validBody,
          priceType: 'hourly',
          price: 80.5,
          deliveryDays: 3,
          isRemote: true,
          // Nada disto é do cliente decidir: dono, visibilidade e contadores.
          userId: 99,
          ownerId: 99,
          isActive: false,
          viewsCount: 1000,
        })
        .expect(201);

      expect(service.create.mock.calls[0]).toEqual([
        7,
        {
          categoryId: 10,
          title: 'Landing page',
          description: 'Faço sua landing page responsiva',
          priceType: 'hourly',
          price: 80.5,
          deliveryDays: 3,
          isRemote: true,
        },
      ]);
    });

    it('preço fixo exige preço (RN-016): sem preço, ou com preço nulo, é recusado na validação', async () => {
      const semPreco = { ...validBody, price: undefined };
      for (const body of [
        semPreco,
        { ...validBody, price: null },
        { ...semPreco, priceType: 'fixed' },
      ]) {
        const res = await request(app).post('/api/services').set(bearer(7)).send(body).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toEqual({ price: ['Preço obrigatório para preço fixo'] });
      }
      expect(service.create).not.toHaveBeenCalled();
    });

    it('a combinar e por hora podem ficar sem preço (RN-016 só cobra do preço fixo)', async () => {
      service.create.mockResolvedValue({ ...landing, priceType: 'negotiable', price: null });

      await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ ...validBody, price: null, priceType: 'negotiable', deliveryDays: null })
        .expect(201);
      await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ ...validBody, price: undefined, priceType: 'hourly' })
        .expect(201);

      expect(service.create.mock.calls[0]![1]).toEqual({
        categoryId: 10,
        title: 'Landing page',
        description: 'Faço sua landing page responsiva',
        priceType: 'negotiable',
        price: null,
        deliveryDays: null,
        isRemote: false,
      });
      expect(service.create.mock.calls[1]![1]).toEqual({
        categoryId: 10,
        title: 'Landing page',
        description: 'Faço sua landing page responsiva',
        priceType: 'hourly',
        isRemote: false,
      });
    });

    it.each([
      ['categoryId', 0],
      ['categoryId', 2.5],
      ['categoryId', '10'], // no corpo JSON o número tem de ser número
      ['title', 'ab'],
      ['title', 'x'.repeat(151)],
      ['description', 'curta'],
      ['priceType', 'free'],
      ['price', 0],
      ['price', -10],
      ['price', '500'],
      ['deliveryDays', 0],
      ['deliveryDays', 1.5],
      ['isRemote', 'true'],
    ])('%s inválido (%j) é recusado na validação', async (field, value) => {
      const res = await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ ...validBody, [field]: value })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details)).toEqual([field]);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('os limites do título valem dos dois lados: 3 e 150 caracteres passam', async () => {
      service.create.mockResolvedValue(landing);
      for (const title of ['abc', 'x'.repeat(150)]) {
        await request(app)
          .post('/api/services')
          .set(bearer(7))
          .send({ ...validBody, title })
          .expect(201);
      }
      expect(
        service.create.mock.calls.map((c) => (c[1] as { title: string }).title.length),
      ).toEqual([3, 150]);
    });

    it('a descrição precisa de pelo menos 10 caracteres: 9 é recusado, 10 passa', async () => {
      service.create.mockResolvedValue(landing);
      const res = await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ ...validBody, description: 'x'.repeat(9) })
        .expect(422);
      expect(Object.keys(res.body.details)).toEqual(['description']);
      expect(service.create).not.toHaveBeenCalled();

      await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ ...validBody, description: 'x'.repeat(10) })
        .expect(201);
      expect(service.create).toHaveBeenCalledTimes(1);
      expect((service.create.mock.calls[0]![1] as { description: string }).description).toBe(
        'x'.repeat(10),
      );
    });

    it('sem os campos obrigatórios, aponta cada um que faltou', async () => {
      const res = await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ priceType: 'negotiable' })
        .expect(422);
      expect(Object.keys(res.body.details).sort()).toEqual(['categoryId', 'description', 'title']);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('preço abaixo do mínimo da plataforma: a recusa do service vira 422 price_below_minimum', async () => {
      service.create.mockRejectedValue(
        new HttpError(422, 'Preço mínimo é R$ 10,00 (RN-016)', 'price_below_minimum'),
      );
      const res = await request(app)
        .post('/api/services')
        .set(bearer(7))
        .send({ ...validBody, price: 5 })
        .expect(422);
      expect(res.body).toEqual({
        error: 'price_below_minimum',
        message: 'Preço mínimo é R$ 10,00 (RN-016)',
      });
    });
  });

  describe('PATCH /api/services/:id', () => {
    it('exige login', async () => {
      const res = await request(app).patch('/api/services/5').send({ title: 'Novo título' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.update).not.toHaveBeenCalled();
    });

    it('edita em nome de quem está logado e só repassa os campos enviados', async () => {
      const updated = { ...landing, title: 'Novo título', isActive: false };
      service.update.mockResolvedValue(updated);

      const res = await request(app)
        .patch('/api/services/5')
        .set(bearer(7))
        .send({ title: 'Novo título', isActive: false })
        .expect(200);

      expect(res.body).toEqual(updated);
      expect(service.update).toHaveBeenCalledTimes(1);
      expect(service.update.mock.calls[0]).toEqual([
        5,
        7,
        { title: 'Novo título', isActive: false },
      ]);
    });

    it('todos os campos editáveis passam, inclusive zerar preço e prazo com null', async () => {
      service.update.mockResolvedValue(landing);
      const body = {
        categoryId: 11,
        title: 'Site completo',
        description: 'Site institucional de até cinco páginas',
        priceType: 'negotiable',
        price: null,
        deliveryDays: null,
        isRemote: false,
        isActive: true,
      };
      await request(app).patch('/api/services/5').set(bearer(7)).send(body).expect(200);
      expect(service.update.mock.calls[0]).toEqual([5, 7, body]);
    });

    it('campo fora da lista (dono, contadores, exclusão) é descartado antes do service', async () => {
      service.update.mockResolvedValue(landing);
      await request(app)
        .patch('/api/services/5')
        .set(bearer(7))
        .send({
          title: 'Novo título',
          userId: 99,
          user_id: 99,
          views_count: 1000,
          deleted_at: null,
        })
        .expect(200);
      expect(service.update.mock.calls[0]).toEqual([5, 7, { title: 'Novo título' }]);
    });

    it('corpo vazio é válido (nenhum campo é obrigatório na edição)', async () => {
      service.update.mockResolvedValue(landing);
      await request(app).patch('/api/services/5').set(bearer(7)).send({}).expect(200);
      expect(service.update.mock.calls[0]).toEqual([5, 7, {}]);
    });

    it.each([
      ['categoryId', -1],
      ['categoryId', 0],
      ['categoryId', 2.5],
      ['categoryId', '11'], // no corpo JSON o número tem de ser número
      ['categoryId', null],
      ['title', 'ab'],
      ['title', 'x'.repeat(151)],
      ['title', null],
      ['description', 'curta'],
      ['description', 'x'.repeat(9)],
      ['priceType', 'free'],
      ['priceType', null],
      ['price', 0],
      ['price', -10],
      ['price', '500'],
      ['deliveryDays', 0],
      ['deliveryDays', 1.5],
      ['deliveryDays', '7'],
      ['isRemote', 1],
      ['isRemote', null],
      ['isActive', 'false'],
      ['isActive', null],
    ])('%s inválido (%j) é recusado na validação', async (field, value) => {
      const res = await request(app)
        .patch('/api/services/5')
        .set(bearer(7))
        .send({ [field]: value })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details)).toEqual([field]);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('os limites de título e descrição valem na edição: 3 e 150 caracteres no título e 10 na descrição passam', async () => {
      service.update.mockResolvedValue(landing);
      const bodies = [
        { title: 'abc' },
        { title: 'x'.repeat(150) },
        { description: 'x'.repeat(10) },
      ];
      for (const body of bodies) {
        await request(app).patch('/api/services/5').set(bearer(7)).send(body).expect(200);
      }
      expect(service.update.mock.calls).toEqual(bodies.map((body) => [5, 7, body]));
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-4', '1.5']) {
        const res = await request(app)
          .patch(`/api/services/${id}`)
          .set(bearer(7))
          .send({ title: 'Novo título' })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      expect(service.update).not.toHaveBeenCalled();
    });

    it('serviço inexistente: o 404 do service chega como service_not_found', async () => {
      service.update.mockRejectedValue(
        new HttpError(404, 'Serviço não encontrado', 'service_not_found'),
      );
      const res = await request(app)
        .patch('/api/services/999')
        .set(bearer(7))
        .send({ title: 'Novo título' })
        .expect(404);
      expect(res.body).toEqual({ error: 'service_not_found', message: 'Serviço não encontrado' });
      expect(service.update.mock.calls[0]).toEqual([999, 7, { title: 'Novo título' }]);
    });

    it('preço abaixo do mínimo na edição: a recusa do service vira 422 price_below_minimum (RN-016)', async () => {
      service.update.mockRejectedValue(
        new HttpError(422, 'Preço mínimo é R$ 10,00 (RN-016)', 'price_below_minimum'),
      );
      const res = await request(app)
        .patch('/api/services/5')
        .set(bearer(7))
        .send({ price: 5 })
        .expect(422);
      expect(res.body).toEqual({
        error: 'price_below_minimum',
        message: 'Preço mínimo é R$ 10,00 (RN-016)',
      });
      expect(service.update.mock.calls[0]).toEqual([5, 7, { price: 5 }]);
    });

    it('só o dono edita: o 403 do service chega como forbidden', async () => {
      service.update.mockRejectedValue(
        new HttpError(403, 'Você não é o dono deste serviço', 'forbidden'),
      );
      const res = await request(app)
        .patch('/api/services/5')
        .set(bearer(8))
        .send({ title: 'Novo título' })
        .expect(403);
      expect(res.body).toEqual({ error: 'forbidden', message: 'Você não é o dono deste serviço' });
      expect(service.update.mock.calls[0]).toEqual([5, 8, { title: 'Novo título' }]);
    });
  });

  describe('DELETE /api/services/:id', () => {
    it('exige login', async () => {
      const res = await request(app).delete('/api/services/5');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('remove em nome de quem está logado e responde 204 sem corpo', async () => {
      service.remove.mockResolvedValue(undefined);
      const res = await request(app).delete('/api/services/5').set(bearer(7));
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(service.remove).toHaveBeenCalledTimes(1);
      expect(service.remove).toHaveBeenCalledWith(5, 7);
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-4', '1.5']) {
        const res = await request(app).delete(`/api/services/${id}`).set(bearer(7)).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('serviço inexistente: o 404 do service chega como service_not_found', async () => {
      service.remove.mockRejectedValue(
        new HttpError(404, 'Serviço não encontrado', 'service_not_found'),
      );
      const res = await request(app).delete('/api/services/999').set(bearer(7)).expect(404);
      expect(res.body).toEqual({ error: 'service_not_found', message: 'Serviço não encontrado' });
      expect(service.remove.mock.calls).toEqual([[999, 7]]);
    });

    it('só o dono remove: o 403 do service chega como forbidden', async () => {
      service.remove.mockRejectedValue(
        new HttpError(403, 'Você não é o dono deste serviço', 'forbidden'),
      );
      const res = await request(app).delete('/api/services/5').set(bearer(8)).expect(403);
      expect(res.body).toEqual({ error: 'forbidden', message: 'Você não é o dono deste serviço' });
      expect(service.remove).toHaveBeenCalledWith(5, 8);
    });
  });

  it('token inválido não passa por nenhuma rota protegida', async () => {
    const bad = { Authorization: 'Bearer nao-e-um-jwt' };
    const responses = [
      await request(app).post('/api/services').set(bad).send(validBody),
      await request(app).patch('/api/services/5').set(bad).send({ title: 'Novo título' }),
      await request(app).delete('/api/services/5').set(bad),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('conta suspensa ou banida não cria, edita nem remove serviço, mesmo com token válido (RN-007)', async () => {
    blocklist.add(66);
    try {
      const responses = [
        await request(app).post('/api/services').set(bearer(66)).send(validBody),
        await request(app).patch('/api/services/5').set(bearer(66)).send({ title: 'Novo título' }),
        await request(app).delete('/api/services/5').set(bearer(66)),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
    } finally {
      blocklist.delete(66);
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('falha inesperada do service vira 500 sem expor o erro, em qualquer rota (RNF-039)', async () => {
    const boom = new Error('ECONNREFUSED 127.0.0.1:3306');
    for (const fn of Object.values(service)) fn.mockRejectedValueOnce(boom);

    const responses = [
      await request(app).get('/api/services'),
      await request(app).get('/api/services/5'),
      await request(app).post('/api/services').set(bearer(7)).send(validBody),
      await request(app).patch('/api/services/5').set(bearer(7)).send({ title: 'Novo título' }),
      await request(app).delete('/api/services/5').set(bearer(7)),
    ];

    for (const res of responses) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    }
    // Cada rota chegou ao seu service (a falha não foi de validação nem de login).
    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.getById.mock.calls).toEqual([[5]]);
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.update.mock.calls).toEqual([[5, 7, { title: 'Novo título' }]]);
    expect(service.remove.mock.calls).toEqual([[5, 7]]);
  });

  it('vários filtros inválidos de uma vez: a resposta aponta cada um, e a busca não roda', async () => {
    const res = await request(app)
      .get('/api/services?categoryId=abc&day=9&sort=cheapest&limit=1000')
      .expect(422);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.message).toBe('Dados de entrada inválidos');
    expect(Object.keys(res.body.details).sort()).toEqual(['categoryId', 'day', 'limit', 'sort']);
    expect(service.list).not.toHaveBeenCalled();
  });
});
