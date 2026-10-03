import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { settingsRoutes } from './settings.routes';

const { service } = vi.hoisted(() => ({
  service: { publicSettings: vi.fn(), update: vi.fn(), listForAdmin: vi.fn() },
}));
vi.mock('./settings.service', () => ({ settingsService: service }));

const app = routerApp('/api/settings', settingsRoutes);

const publicSettings = {
  platformFeePercentage: 15,
  tacitApprovalDays: 5,
  proposalExpiryHours: 72,
  deadlineGraceHours: 24,
  extensionResponseHours: 48,
  minServicePrice: 10,
  minWithdrawalAmount: 20,
  barterEnabled: true,
  maintenanceMode: false,
};

/**
 * Rota e controller dos parâmetros públicos (ADR 32 e 33): o app lê taxa, prazos e mínimos sem
 * login. Editar é do painel admin (/api/admin), não deste router.
 */
describe('parâmetros da plataforma: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /api/settings/public', () => {
    it('devolve os parâmetros públicos sem login, como o service entrega', async () => {
      service.publicSettings.mockResolvedValue(publicSettings);

      const res = await request(app).get('/api/settings/public').expect(200);

      expect(res.body).toEqual(publicSettings);
      expect(service.publicSettings).toHaveBeenCalledTimes(1);
      expect(service.publicSettings).toHaveBeenCalledWith();
    });

    it('é pública de verdade: nem token inválido barra, e com login a resposta é a mesma', async () => {
      service.publicSettings.mockResolvedValue(publicSettings);

      const invalid = await request(app)
        .get('/api/settings/public')
        .set({ Authorization: 'Bearer nao.e.um-jwt' });
      const logged = await request(app).get('/api/settings/public').set(bearer(7));

      expect(invalid.status).toBe(200);
      expect(invalid.body).toEqual(publicSettings);
      expect(logged.status).toBe(200);
      expect(logged.body).toEqual(publicSettings);
      expect(service.publicSettings).toHaveBeenCalledTimes(2);
    });

    it('se a leitura falha, responde 500 em JSON sem expor o erro do banco (RNF-039)', async () => {
      service.publicSettings.mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:3306 (user 'escambo')"),
      );

      const res = await request(app).get('/api/settings/public').expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  it('este router só lê: não há rota para listar tudo nem para alterar um parâmetro', async () => {
    const attempts = [
      request(app).get('/api/settings').set(bearer(1, 'admin')),
      request(app).post('/api/settings/public').set(bearer(1, 'admin')).send({ value: 1 }),
      request(app)
        .put('/api/settings/maintenance_mode')
        .set(bearer(1, 'admin'))
        .send({ value: true }),
      request(app).patch('/api/settings/public').set(bearer(1, 'admin')).send({ value: true }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
});
