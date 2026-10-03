import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { favoritesRoutes } from './favorites.routes';

const { service } = vi.hoisted(() => ({
  service: { add: vi.fn(), remove: vi.fn(), list: vi.fn() },
}));
vi.mock('./favorites.service', () => ({ favoritesService: service }));

const app = routerApp('/api/favorites', favoritesRoutes);

/** Rotas e controllers dos favoritos: tudo exige login, e o favorito é sempre de quem está logado. */
describe('favoritos: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('todas as rotas exigem login: sem token é 401 e nada chega ao service', async () => {
    const calls = [
      request(app).get('/api/favorites'),
      request(app).post('/api/favorites').send({ targetType: 'service', targetId: 5 }),
      request(app).delete('/api/favorites/service/5'),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.add).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('token inválido é 401 invalid_token', async () => {
    const res = await request(app)
      .get('/api/favorites')
      .set({ Authorization: 'Bearer nao-e-um-jwt' })
      .expect(401);
    expect(res.body.error).toBe('invalid_token');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('token inválido não passa por nenhuma das rotas, nem pelas de escrita', async () => {
    const bad = { Authorization: 'Bearer nao-e-um-jwt' };
    const responses = [
      await request(app)
        .post('/api/favorites')
        .set(bad)
        .send({ targetType: 'service', targetId: 5 }),
      await request(app).delete('/api/favorites/service/5').set(bad),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
    }
    expect(service.add).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('conta suspensa ou banida não lista, favorita nem desfavorita, mesmo com token válido (RN-007)', async () => {
    blocklist.add(66);
    try {
      const responses = [
        await request(app).get('/api/favorites').set(bearer(66)),
        await request(app)
          .post('/api/favorites')
          .set(bearer(66))
          .send({ targetType: 'service', targetId: 5 }),
        await request(app).delete('/api/favorites/service/5').set(bearer(66)),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
    } finally {
      blocklist.delete(66);
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.add).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  describe('POST /api/favorites', () => {
    it('favorita em nome de quem está logado e responde 201', async () => {
      service.add.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetType: 'freelancer', targetId: 44 })
        .expect(201);
      expect(res.body).toEqual({ ok: true });
      expect(service.add).toHaveBeenCalledTimes(1);
      expect(service.add).toHaveBeenCalledWith(7, { targetType: 'freelancer', targetId: 44 });
    });

    it('o dono do favorito vem do token: userId no corpo é descartado', async () => {
      service.add.mockResolvedValue(undefined);
      await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetType: 'service', targetId: 5, userId: 99 })
        .expect(201);
      expect(service.add).toHaveBeenCalledWith(7, { targetType: 'service', targetId: 5 });
    });

    it('só serviço ou freelancer podem ser favoritados', async () => {
      const res = await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetType: 'contract', targetId: 5 })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      // Só o tipo é recusado: o id do alvo estava certo.
      expect(Object.keys(res.body.details)).toEqual(['targetType']);
      expect(service.add).not.toHaveBeenCalled();
    });

    it('o alvo precisa ser um id inteiro positivo, e número de verdade no corpo', async () => {
      for (const targetId of [0, -3, 1.5, '5', null]) {
        const res = await request(app)
          .post('/api/favorites')
          .set(bearer(7))
          .send({ targetType: 'service', targetId })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['targetId']);
      }
      const semAlvo = await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetType: 'service' })
        .expect(422);
      expect(semAlvo.body.error).toBe('validation_error');
      expect(Object.keys(semAlvo.body.details)).toEqual(['targetId']);
      expect(service.add).not.toHaveBeenCalled();
    });

    it('uma recusa do service ao favoritar (HttpError) vira a resposta com o status e o código dela, e não o 201', async () => {
      service.add.mockRejectedValueOnce(new HttpError(409, 'Recusado pelo service', 'refused'));
      const res = await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetType: 'service', targetId: 5 })
        .expect(409);
      expect(res.body).toEqual({ error: 'refused', message: 'Recusado pelo service' });
      expect(service.add.mock.calls).toEqual([[7, { targetType: 'service', targetId: 5 }]]);
    });

    it('sem o tipo do alvo, ou com corpo vazio, a validação aponta o que faltou', async () => {
      const semTipo = await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetId: 5 })
        .expect(422);
      expect(semTipo.body.error).toBe('validation_error');
      expect(Object.keys(semTipo.body.details)).toEqual(['targetType']);

      const vazio = await request(app).post('/api/favorites').set(bearer(7)).send({}).expect(422);
      expect(Object.keys(vazio.body.details).sort()).toEqual(['targetId', 'targetType']);
      expect(service.add).not.toHaveBeenCalled();
    });

    it('falha inesperada ao favoritar vira 500 sem expor o erro, e não o 201', async () => {
      service.add.mockRejectedValueOnce(new Error('ER_LOCK_DEADLOCK'));
      const res = await request(app)
        .post('/api/favorites')
        .set(bearer(7))
        .send({ targetType: 'service', targetId: 5 })
        .expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('GET /api/favorites', () => {
    it('lista só os favoritos de quem está logado', async () => {
      const favorites = [
        { id: 2, targetType: 'service', targetId: 5, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 1, targetType: 'freelancer', targetId: 44, createdAt: '2026-01-01T00:00:00.000Z' },
      ];
      service.list.mockResolvedValue(favorites);
      const res = await request(app).get('/api/favorites').set(bearer(7)).expect(200);
      expect(res.body).toEqual(favorites);
      expect(service.list).toHaveBeenCalledTimes(1);
      expect(service.list).toHaveBeenCalledWith(7);
    });

    it('quem não favoritou nada recebe a lista vazia (200, e não 404), e o dono é sempre o do token', async () => {
      service.list.mockResolvedValue([]);
      // userId na URL não troca de dono: a lista é de quem está logado.
      const res = await request(app).get('/api/favorites?userId=99').set(bearer(8)).expect(200);
      expect(res.body).toEqual([]);
      expect(service.list.mock.calls).toEqual([[8]]);
    });

    it('falha inesperada do service vira 500 sem expor o erro', async () => {
      service.list.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3306'));
      const res = await request(app).get('/api/favorites').set(bearer(7)).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('DELETE /api/favorites/:targetType/:targetId', () => {
    it('desfavorita em nome de quem está logado, com o id convertido para número, e responde 204 sem corpo', async () => {
      service.remove.mockResolvedValue(undefined);
      const res = await request(app).delete('/api/favorites/freelancer/44').set(bearer(7));
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(service.remove).toHaveBeenCalledTimes(1);
      expect(service.remove).toHaveBeenCalledWith(7, 'freelancer', 44);
    });

    it('tipo desconhecido ou id que não é inteiro positivo são recusados na validação', async () => {
      const tipo = await request(app)
        .delete('/api/favorites/contract/5')
        .set(bearer(7))
        .expect(422);
      expect(tipo.body.error).toBe('validation_error');
      expect(Object.keys(tipo.body.details)).toEqual(['targetType']);
      for (const targetId of ['abc', '0', '-1', '2.5']) {
        const res = await request(app)
          .delete(`/api/favorites/service/${targetId}`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['targetId']);
      }
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('desfavorita serviço e freelancer: os dois tipos passam, cada um com o seu alvo', async () => {
      service.remove.mockResolvedValue(undefined);
      await request(app).delete('/api/favorites/service/5').set(bearer(7)).expect(204);
      await request(app).delete('/api/favorites/freelancer/5').set(bearer(7)).expect(204);
      expect(service.remove.mock.calls).toEqual([
        [7, 'service', 5],
        [7, 'freelancer', 5],
      ]);
    });

    it('falha inesperada ao desfavoritar vira 500 sem expor o erro, e não o 204', async () => {
      service.remove.mockRejectedValueOnce(new Error('ER_LOCK_DEADLOCK'));
      const res = await request(app).delete('/api/favorites/service/5').set(bearer(7)).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });

    it('a recusa do service vira a resposta com o código dele', async () => {
      service.remove.mockRejectedValueOnce(
        new HttpError(404, 'Favorito não encontrado', 'not_found'),
      );
      const res = await request(app).delete('/api/favorites/service/5').set(bearer(7)).expect(404);
      expect(res.body).toEqual({ error: 'not_found', message: 'Favorito não encontrado' });
      expect(service.remove.mock.calls).toEqual([[7, 'service', 5]]);
    });

    it('cada conta só desfavorita o que é seu: o dono vem do token de quem chamou', async () => {
      service.remove.mockResolvedValue(undefined);
      await request(app).delete('/api/favorites/service/5').set(bearer(7)).expect(204);
      await request(app).delete('/api/favorites/service/5').set(bearer(8)).expect(204);
      expect(service.remove.mock.calls).toEqual([
        [7, 'service', 5],
        [8, 'service', 5],
      ]);
    });

    it('sem o id do alvo no caminho a rota não existe (404 padrão), e nada é apagado', async () => {
      const res = await request(app).delete('/api/favorites/service').set(bearer(7)).expect(404);
      expect(res.body.error).toBe('not_found');
      expect(service.remove).not.toHaveBeenCalled();
    });
  });
});
