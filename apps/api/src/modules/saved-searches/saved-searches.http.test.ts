import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { savedSearchesRoutes } from './saved-searches.routes';

const { service } = vi.hoisted(() => ({
  service: { create: vi.fn(), list: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('./saved-searches.service', () => ({ savedSearchesService: service }));

const app = routerApp('/api/saved-searches', savedSearchesRoutes);

const saved = {
  id: 3,
  name: 'Devs em SC',
  query: 'react',
  filters: { categoryId: 10 },
  alertEnabled: true,
  alertFrequency: 'daily',
  lastAlertAt: '2026-09-15T10:00:00.000Z',
  createdAt: '2026-09-15T10:00:00.000Z',
};

/**
 * Rotas e controllers das buscas salvas (ADR 35 e 37): toda rota é da pessoa logada, a validação
 * decide o que pode ser salvo e o que o PATCH pode mudar, e o id de quem está logado é o que
 * chega ao service.
 */
describe('buscas salvas: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('todas as rotas exigem login', () => {
    const routes: Array<['get' | 'post' | 'patch' | 'delete', string]> = [
      ['post', '/api/saved-searches'],
      ['get', '/api/saved-searches'],
      ['patch', '/api/saved-searches/3'],
      ['delete', '/api/saved-searches/3'],
    ];

    it.each(routes)('%s %s sem token é 401 e não chega ao service', async (method, path) => {
      const res = await request(app)[method](path).send({ query: 'react', alertEnabled: true });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('token que não foi assinado pela API é recusado', async () => {
      const res = await request(app)
        .get('/api/saved-searches')
        .set({ Authorization: 'Bearer nao.e.um-jwt' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.list).not.toHaveBeenCalled();
    });

    describe('conta suspensa ou banida (RN-007)', () => {
      afterEach(() => blocklist.delete(7));

      it.each(routes)(
        '%s %s barra a conta bloqueada mesmo com token válido',
        async (method, path) => {
          blocklist.add(7);
          const agent = request(app);
          const res = await agent[method](path)
            .set(bearer(7))
            .send({ query: 'react', alertEnabled: true });
          expect(res.status).toBe(403);
          expect(res.body.error).toBe('account_blocked');
          for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe('POST /api/saved-searches', () => {
    it('salva em nome de quem está logado, com texto e nome sem espaços nas pontas', async () => {
      service.create.mockResolvedValue(saved);
      const filters = {
        categoryId: 10,
        isRemote: false,
        lat: -26.3,
        lng: -48.84,
        radiusKm: 50,
        minPrice: 0,
        maxPrice: 500,
        maxDeliveryDays: 7,
        minRating: 4.5,
        day: 6,
        period: 'morning',
      };

      const res = await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({
          name: '  Devs em SC ',
          query: ' react ',
          filters,
          alertEnabled: true,
          alertFrequency: 'daily',
          // O dono e o cursor do alerta não são de quem salva: a validação descarta.
          userId: 1,
          lastAlertAt: '2020-01-01T00:00:00Z',
        })
        .expect(201);

      expect(res.body).toEqual(saved);
      expect(service.create).toHaveBeenCalledTimes(1);
      expect(service.create).toHaveBeenCalledWith(7, {
        name: 'Devs em SC',
        query: 'react',
        filters,
        alertEnabled: true,
        alertFrequency: 'daily',
      });
    });

    it('basta o texto, ou basta um filtro; alerta e frequência ficam para o service decidir o padrão', async () => {
      service.create.mockResolvedValue(saved);

      await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({ query: 'logo' })
        .expect(201);
      await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({ name: null, query: null, filters: { isRemote: true } })
        .expect(201);

      expect(service.create).toHaveBeenNthCalledWith(1, 7, { query: 'logo' });
      expect(service.create).toHaveBeenNthCalledWith(2, 7, {
        name: null,
        query: null,
        filters: { isRemote: true },
      });
    });

    it('busca sem texto e sem filtro não é salva, com a mensagem no campo do texto', async () => {
      for (const body of [
        {},
        { name: 'Vazia' },
        { query: '   ', filters: {} },
        { query: null, filters: null },
      ]) {
        const res = await request(app)
          .post('/api/saved-searches')
          .set(bearer(7))
          .send(body)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toEqual({
          query: ['Salve uma busca com texto ou pelo menos um filtro'],
        });
      }
      expect(service.create).not.toHaveBeenCalled();
    });

    it('filtro que a busca de serviços não conhece é recusado (ADR 35: sem ordenação nem "atende agora")', async () => {
      for (const filters of [
        { sort: 'price' },
        { availableNow: true },
        { categoryId: 10, q: 'x' },
      ]) {
        const res = await request(app)
          .post('/api/saved-searches')
          .set(bearer(7))
          .send({ query: 'react', filters })
          .expect(422);
        expect(Object.keys(res.body.details)).toEqual(['filters']);
      }
      expect(service.create).not.toHaveBeenCalled();
    });

    it('período só vale junto com o dia, e latitude e longitude vão juntas', async () => {
      const period = await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({ query: 'react', filters: { period: 'morning' } })
        .expect(422);
      expect(period.body.details).toEqual({ filters: ['Período só junto com o dia'] });

      for (const filters of [{ lat: -26.3 }, { lng: -48.84 }]) {
        const res = await request(app)
          .post('/api/saved-searches')
          .set(bearer(7))
          .send({ query: 'react', filters })
          .expect(422);
        expect(res.body.details).toEqual({ filters: ['Latitude e longitude vão juntas'] });
      }
      expect(service.create).not.toHaveBeenCalled();

      // O dia sozinho (o dia todo) e o par de coordenadas completo passam.
      service.create.mockResolvedValue(saved);
      await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({ filters: { day: 0, lat: 0, lng: 0 } })
        .expect(201);
      expect(service.create).toHaveBeenCalledWith(7, { filters: { day: 0, lat: 0, lng: 0 } });
    });

    it.each([
      [{ categoryId: 0 }],
      [{ categoryId: 1.5 }],
      [{ isRemote: 'sim' }],
      [{ lat: 90.1, lng: 0 }],
      [{ lat: 0, lng: -180.1 }],
      [{ radiusKm: 0 }],
      [{ radiusKm: 501 }],
      [{ minPrice: -1 }],
      [{ maxPrice: 0 }],
      [{ maxDeliveryDays: 0 }],
      [{ minRating: 5.1 }],
      [{ day: 7 }],
      [{ day: 1, period: 'madrugada' }],
    ])('filtro fora dos limites é recusado: %j', async (filters) => {
      const res = await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({ query: 'react', filters })
        .expect(422);
      expect(Object.keys(res.body.details)).toEqual(['filters']);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('os limites exatos de cada filtro, do nome e do texto ainda passam, e chegam ao service como vieram', async () => {
      service.create.mockResolvedValue(saved);
      const upper = {
        name: 'x'.repeat(120),
        query: 'x'.repeat(255),
        filters: {
          categoryId: 1,
          lat: 90,
          lng: 180,
          radiusKm: 500,
          minPrice: 0,
          maxPrice: 0.01,
          maxDeliveryDays: 1,
          minRating: 5,
          day: 6,
          period: 'evening',
        },
      };
      const lower = {
        name: 'x',
        filters: { lat: -90, lng: -180, radiusKm: 0.1, minRating: 0, day: 0, period: 'afternoon' },
      };

      await request(app).post('/api/saved-searches').set(bearer(7)).send(upper).expect(201);
      await request(app).post('/api/saved-searches').set(bearer(7)).send(lower).expect(201);

      expect(service.create).toHaveBeenNthCalledWith(1, 7, upper);
      expect(service.create).toHaveBeenNthCalledWith(2, 7, lower);
    });

    it('coordenada, nota, dia, prazo e raio logo além do limite também são recusados', async () => {
      for (const filters of [
        { lat: -90.1, lng: 0 },
        { lat: 0, lng: 180.1 },
        { minRating: -0.1 },
        { day: -1 },
        { day: 1.5 },
        { maxDeliveryDays: 1.5 },
        { radiusKm: 500.1 },
      ]) {
        const res = await request(app)
          .post('/api/saved-searches')
          .set(bearer(7))
          .send({ query: 'react', filters })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['filters']);
      }
      expect(service.create).not.toHaveBeenCalled();
    });

    it('nome em branco ou longo, texto longo, alerta que não é sim/não e frequência desconhecida são recusados', async () => {
      for (const [field, patch] of [
        ['name', { name: '   ' }],
        ['name', { name: 'x'.repeat(121) }],
        ['query', { query: 'x'.repeat(256), filters: { isRemote: true } }],
        ['alertEnabled', { alertEnabled: 'true' }],
        // ADR 37: na hora, de hora em hora ou uma vez por dia.
        ['alertFrequency', { alertFrequency: 'weekly' }],
      ] as const) {
        const res = await request(app)
          .post('/api/saved-searches')
          .set(bearer(7))
          .send({ query: 'react', ...patch })
          .expect(422);
        expect(Object.keys(res.body.details)).toEqual([field]);
      }
      expect(service.create).not.toHaveBeenCalled();
    });

    it('as três frequências de alerta são aceitas (ADR 37)', async () => {
      service.create.mockResolvedValue(saved);
      for (const alertFrequency of ['instant', 'hourly', 'daily']) {
        await request(app)
          .post('/api/saved-searches')
          .set(bearer(7))
          .send({ query: 'react', alertFrequency })
          .expect(201);
        expect(service.create).toHaveBeenLastCalledWith(7, { query: 'react', alertFrequency });
      }
    });

    it('no limite de buscas salvas, a recusa do service vira 409 com o código dele', async () => {
      service.create.mockRejectedValue(
        new HttpError(409, 'Você já tem 20 buscas salvas', 'saved_search_limit'),
      );
      const res = await request(app)
        .post('/api/saved-searches')
        .set(bearer(7))
        .send({ query: 'react' })
        .expect(409);
      expect(res.body).toEqual({
        error: 'saved_search_limit',
        message: 'Você já tem 20 buscas salvas',
      });
    });
  });

  describe('GET /api/saved-searches', () => {
    it('lista só as buscas de quem está logado', async () => {
      service.list.mockResolvedValue([saved]);

      const res = await request(app).get('/api/saved-searches').set(bearer(7)).expect(200);

      expect(res.body).toEqual([saved]);
      expect(service.list).toHaveBeenCalledTimes(1);
      expect(service.list).toHaveBeenCalledWith(7);
    });

    it('quem não salvou nenhuma busca recebe 200 com lista vazia, não 404', async () => {
      service.list.mockResolvedValue([]);
      const res = await request(app).get('/api/saved-searches').set(bearer(9)).expect(200);
      expect(res.body).toEqual([]);
      expect(service.list).toHaveBeenCalledWith(9);
    });

    it('se o service falha por um motivo inesperado, responde 500 em JSON sem expor o erro (RNF-039)', async () => {
      service.list.mockRejectedValue(new Error("Table 'saved_searches' doesn't exist"));
      const res = await request(app).get('/api/saved-searches').set(bearer(7)).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('PATCH /api/saved-searches/:id', () => {
    it('renomeia, liga o alerta e troca a frequência da busca da URL, em nome de quem está logado', async () => {
      service.update.mockResolvedValue({ ...saved, name: 'Novo nome' });

      const res = await request(app)
        .patch('/api/saved-searches/3')
        .set(bearer(7))
        .send({ name: ' Novo nome ', alertEnabled: true, alertFrequency: 'instant' })
        .expect(200);

      expect(res.body).toEqual({ ...saved, name: 'Novo nome' });
      expect(service.update).toHaveBeenCalledTimes(1);
      expect(service.update).toHaveBeenCalledWith(3, 7, {
        name: 'Novo nome',
        alertEnabled: true,
        alertFrequency: 'instant',
      });
    });

    it('nome null apaga o nome, e desligar o alerta chega como false (não some na validação)', async () => {
      service.update.mockResolvedValue(saved);

      await request(app)
        .patch('/api/saved-searches/3')
        .set(bearer(7))
        .send({ name: null })
        .expect(200);
      await request(app)
        .patch('/api/saved-searches/3')
        .set(bearer(7))
        .send({ alertEnabled: false })
        .expect(200);

      expect(service.update).toHaveBeenNthCalledWith(1, 3, 7, { name: null });
      expect(service.update).toHaveBeenNthCalledWith(2, 3, 7, { alertEnabled: false });
    });

    it('o texto e os filtros da busca não mudam pelo PATCH: corpo sem nada alterável é recusado', async () => {
      for (const body of [{}, { query: 'outra coisa', filters: { isRemote: true } }]) {
        const res = await request(app)
          .patch('/api/saved-searches/3')
          .set(bearer(7))
          .send(body)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
      }
      expect(service.update).not.toHaveBeenCalled();
    });

    it('junto com um campo alterável, o texto e os filtros são descartados antes do service', async () => {
      service.update.mockResolvedValue(saved);
      await request(app)
        .patch('/api/saved-searches/3')
        .set(bearer(7))
        .send({ alertFrequency: 'hourly', query: 'outra coisa', filters: { isRemote: true } })
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(3, 7, { alertFrequency: 'hourly' });
    });

    it('id que não é inteiro positivo, nome em branco e frequência desconhecida são recusados', async () => {
      for (const id of ['abc', '0', '-1', '1.5']) {
        const res = await request(app)
          .patch(`/api/saved-searches/${id}`)
          .set(bearer(7))
          .send({ alertEnabled: true })
          .expect(422);
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      for (const [field, body] of [
        ['name', { name: '  ' }],
        ['alertEnabled', { alertEnabled: 1 }],
        ['alertFrequency', { alertFrequency: 'weekly' }],
      ] as const) {
        const res = await request(app)
          .patch('/api/saved-searches/3')
          .set(bearer(7))
          .send(body)
          .expect(422);
        expect(Object.keys(res.body.details)).toEqual([field]);
      }
      expect(service.update).not.toHaveBeenCalled();
    });

    it('busca de outra pessoa: o 404 do service chega com o código dele', async () => {
      service.update.mockRejectedValue(
        new HttpError(404, 'Busca salva não encontrada', 'saved_search_not_found'),
      );
      const res = await request(app)
        .patch('/api/saved-searches/99')
        .set(bearer(7))
        .send({ alertEnabled: false })
        .expect(404);
      expect(res.body).toEqual({
        error: 'saved_search_not_found',
        message: 'Busca salva não encontrada',
      });
    });
  });

  describe('DELETE /api/saved-searches/:id', () => {
    it('apaga a busca da URL em nome de quem está logado e responde 204 sem corpo', async () => {
      service.remove.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/saved-searches/12').set(bearer(7));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(service.remove).toHaveBeenCalledTimes(1);
      expect(service.remove).toHaveBeenCalledWith(12, 7);
    });

    it('id que não é inteiro positivo é recusado', async () => {
      for (const id of ['abc', '0', '-1', '1.5']) {
        const res = await request(app)
          .delete(`/api/saved-searches/${id}`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('busca de outra pessoa (ou que não existe) é 404, e não 204', async () => {
      service.remove.mockRejectedValue(
        new HttpError(404, 'Busca salva não encontrada', 'saved_search_not_found'),
      );
      const res = await request(app).delete('/api/saved-searches/99').set(bearer(7)).expect(404);
      expect(res.body).toEqual({
        error: 'saved_search_not_found',
        message: 'Busca salva não encontrada',
      });
      expect(service.remove).toHaveBeenCalledWith(99, 7);
    });
  });
});
