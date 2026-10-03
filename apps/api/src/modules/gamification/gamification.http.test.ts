import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { gamificationRoutes } from './gamification.routes';

const { service } = vi.hoisted(() => ({
  service: { getProfile: vi.fn(), getHistory: vi.fn(), getLeaderboard: vi.fn() },
}));
vi.mock('./gamification.service', () => ({ gamificationService: service }));

const app = routerApp('/api/gamification', gamificationRoutes);

/** Rotas e controllers da gamificação: quem pode chamar e o que chega ao service. */
describe('gamificação: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('todas as rotas exigem login', async () => {
    for (const path of ['/me', '/me/history', '/leaderboard']) {
      const res = await request(app).get(`/api/gamification${path}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    const forged = await request(app)
      .get('/api/gamification/me')
      .set({ Authorization: 'Bearer nao-e-um-jwt' });
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe('invalid_token');

    expect(service.getProfile).not.toHaveBeenCalled();
    expect(service.getHistory).not.toHaveBeenCalled();
    expect(service.getLeaderboard).not.toHaveBeenCalled();
  });

  describe('GET /api/gamification/me', () => {
    it('devolve o perfil de gamificação de quem está logado', async () => {
      const profile = {
        totalXp: 350,
        level: 2,
        levelName: 'Aprendiz',
        progress: {
          level: 2,
          levelName: 'Aprendiz',
          currentLevelMin: 300,
          nextLevelMin: 800,
          xpIntoLevel: 50,
          xpToNextLevel: 450,
          percent: 10,
        },
        streakDays: 3,
        rank: 5,
        badges: [{ slug: 'first-deal', name: 'First Deal', awardedAt: '2026-01-01T00:00:00.000Z' }],
      };
      service.getProfile.mockResolvedValue(profile);

      const res = await request(app).get('/api/gamification/me').set(bearer(7)).expect(200);

      expect(res.body).toEqual(profile);
      expect(service.getProfile).toHaveBeenCalledTimes(1);
      expect(service.getProfile).toHaveBeenCalledWith(7);
      expect(service.getHistory).not.toHaveBeenCalled();
    });

    it('o perfil é sempre o do token: não dá para pedir o de outro usuário pela query', async () => {
      service.getProfile.mockResolvedValue({});
      await request(app).get('/api/gamification/me?userId=99').set(bearer(8)).expect(200);
      expect(service.getProfile).toHaveBeenCalledWith(8);
    });
  });

  describe('GET /api/gamification/me/history', () => {
    it('devolve os ganhos de XP de quem está logado, no tamanho padrão do service', async () => {
      const events = [
        { amount: 100, reason: 'contract_completed', at: '2026-03-10T12:00:00.000Z' },
        { amount: 50, reason: 'review_5_stars', at: '2026-03-09T12:00:00.000Z' },
      ];
      service.getHistory.mockResolvedValue(events);

      const res = await request(app).get('/api/gamification/me/history').set(bearer(7)).expect(200);

      expect(res.body).toEqual(events);
      // Só o uid: o limite não vem do cliente (um ?limit= na URL não chega ao service).
      expect(service.getHistory).toHaveBeenCalledTimes(1);
      expect(service.getHistory).toHaveBeenCalledWith(7);
      // "/me/history" não pode ser atendida pela rota "/me".
      expect(service.getProfile).not.toHaveBeenCalled();
    });

    it('um ?limit= na URL é ignorado', async () => {
      service.getHistory.mockResolvedValue([]);
      const res = await request(app)
        .get('/api/gamification/me/history?limit=5000&userId=99')
        .set(bearer(8))
        .expect(200);
      expect(res.body).toEqual([]);
      expect(service.getHistory).toHaveBeenCalledTimes(1);
      // toHaveBeenCalledWith(8) recusa um segundo argumento: o limite fica no padrão do service.
      expect(service.getHistory).toHaveBeenCalledWith(8);
    });
  });

  describe('GET /api/gamification/leaderboard', () => {
    it('devolve o ranking, igual para qualquer usuário logado e sem parâmetros do cliente', async () => {
      const board = [
        {
          rank: 1,
          userUlid: '01HXA',
          name: 'Ana',
          totalXp: 900,
          level: 3,
          levelName: 'Profissional',
        },
        { rank: 2, userUlid: '01HXB', name: null, totalXp: 100, level: 1, levelName: 'Iniciante' },
      ];
      service.getLeaderboard.mockResolvedValue(board);

      const res = await request(app)
        .get('/api/gamification/leaderboard?limit=5000')
        .set(bearer(7))
        .expect(200);

      expect(res.body).toEqual(board);
      expect(service.getLeaderboard).toHaveBeenCalledTimes(1);
      expect(service.getLeaderboard).toHaveBeenCalledWith();
    });
  });

  it('erro inesperado do service vira 500 sem vazar o motivo (RNF-039)', async () => {
    service.getProfile.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3306'));
    const res = await request(app).get('/api/gamification/me').set(bearer(7)).expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
  });

  // Cada rota precisa entregar a falha ao tratamento global: sem isso a requisição fica sem resposta.
  it.each([
    ['/me/history', 'getHistory'],
    ['/leaderboard', 'getLeaderboard'],
  ] as const)('falha do service em %s também vira 500 padronizado (RNF-039)', async (path, fn) => {
    service[fn].mockRejectedValue(new Error('ER_NO_SUCH_TABLE: xp_transactions'));
    const res = await request(app).get(`/api/gamification${path}`).set(bearer(7)).expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
  });

  it('a gamificação é só leitura pela API: não há rota para creditar XP ou conceder badge', async () => {
    for (const path of ['/me', '/me/history', '/leaderboard']) {
      const res = await request(app)
        .post(`/api/gamification${path}`)
        .set(bearer(7))
        .send({ amount: 5000, reason: 'bonus' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    expect(service.getProfile).not.toHaveBeenCalled();
    expect(service.getHistory).not.toHaveBeenCalled();
    expect(service.getLeaderboard).not.toHaveBeenCalled();
  });
});
