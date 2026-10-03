import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInfo } from '../../config/build-info';
import { routerApp } from '../../test-support/http';
import { healthRoutes } from './health.routes';

const { pingDb } = vi.hoisted(() => ({ pingDb: vi.fn() }));
vi.mock('../../config/db', () => ({ pingDb }));

const app = routerApp('/api/health', healthRoutes);

/**
 * Rotas de saúde: é o que o orquestrador e o deploy consultam, então ficam abertas (sem login) e
 * separam "o processo responde" (live) de "o processo responde E fala com o banco" (readiness).
 */
describe('health: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /api/health (readiness)', () => {
    it('sem login, responde ok com o banco de pé e a identidade do build no ar', async () => {
      pingDb.mockResolvedValue(undefined);

      const res = await request(app).get('/api/health').expect(200);

      expect(pingDb).toHaveBeenCalledTimes(1);
      expect(Object.keys(res.body).sort()).toEqual([
        'commit',
        'db',
        'status',
        'timestamp',
        'uptime',
        'version',
      ]);
      expect(res.body).toMatchObject({
        status: 'ok',
        db: 'up',
        version: buildInfo.version,
        commit: buildInfo.commit,
      });
      expect(Number.isInteger(res.body.uptime)).toBe(true);
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      // ISO em UTC e de agora: é o relógio do servidor que quem faz o deploy confere.
      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
      expect(Math.abs(Date.now() - new Date(res.body.timestamp).getTime())).toBeLessThan(60_000);
    });

    it('com o banco fora vira 500 padronizado, sem vazar o erro do MySQL', async () => {
      pingDb.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:3306'));

      const res = await request(app).get('/api/health').expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });
  });

  describe('GET /api/health/live (liveness)', () => {
    it('responde ok sem tocar no banco, mesmo com ele fora', async () => {
      pingDb.mockRejectedValue(new Error('db down'));

      const res = await request(app).get('/api/health/live').expect(200);

      expect(pingDb).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({
        status: 'ok',
        version: buildInfo.version,
        commit: buildInfo.commit,
      });
      // Liveness não fala do banco: um "db: up" aqui seria mentira.
      expect(res.body).not.toHaveProperty('db');
    });
  });

  it('só GET existe: outro método cai no 404 padronizado e não consulta o banco', async () => {
    const res = await request(app).post('/api/health').send({}).expect(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Rota não encontrada' });
    await request(app).delete('/api/health/live').expect(404);
    expect(pingDb).not.toHaveBeenCalled();
  });
});
