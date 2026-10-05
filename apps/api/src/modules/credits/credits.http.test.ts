import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { creditsRoutes } from './credits.routes';

const { service } = vi.hoisted(() => ({ service: { listTransactions: vi.fn() } }));
vi.mock('./credits.service', () => ({ creditsService: service }));

const app = routerApp('/api/credits', creditsRoutes);

/** Rota e controller do extrato de créditos: exige login, e o extrato é sempre o de quem pede. */
describe('GET /api/credits/transactions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exige login', async () => {
    const res = await request(app).get('/api/credits/transactions').expect(401);
    expect(res.body.error).toBe('missing_token');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('lista o extrato de quem está logado com a paginação padrão', async () => {
    const page = { items: [{ id: 1, amount: 100, reason: 'welcome' }], page: 1, limit: 20 };
    service.listTransactions.mockResolvedValue(page);

    const res = await request(app)
      .get('/api/credits/transactions?userId=99')
      .set(bearer(7))
      .expect(200);

    expect(res.body).toEqual(page);
    expect(service.listTransactions).toHaveBeenCalledTimes(1);
    expect(service.listTransactions).toHaveBeenCalledWith(7, 1, 20);
  });

  it('converte página e limite da URL para número', async () => {
    service.listTransactions.mockResolvedValue({ items: [], page: 4, limit: 100 });

    await request(app).get('/api/credits/transactions?page=4&limit=100').set(bearer(7)).expect(200);

    expect(service.listTransactions).toHaveBeenCalledWith(7, 4, 100);
  });

  it('limite acima de 100 ou página zero é erro de validação e não chega ao service', async () => {
    const limite = await request(app)
      .get('/api/credits/transactions?limit=101')
      .set(bearer(7))
      .expect(422);
    expect(limite.body.error).toBe('validation_error');
    expect(limite.body.details).toHaveProperty('limit');
    const pagina = await request(app)
      .get('/api/credits/transactions?page=0')
      .set(bearer(7))
      .expect(422);
    expect(pagina.body.details).toHaveProperty('page');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('limite zero, página fracionada ou valor que não é número também são recusados', async () => {
    const cases: [string, string][] = [
      ['limit=0', 'limit'],
      ['limit=-5', 'limit'],
      ['limit=2.5', 'limit'],
      ['page=1.5', 'page'],
      ['page=-1', 'page'],
      ['page=abc', 'page'],
    ];
    for (const [query, field] of cases) {
      const res = await request(app).get(`/api/credits/transactions?${query}`).set(bearer(7));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty(field);
    }
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('a página vai até 10000: acima disso (1e20 incluso) é erro de validação, não 500 do OFFSET', async () => {
    for (const page of ['10001', '1e20']) {
      const res = await request(app)
        .get(`/api/credits/transactions?page=${page}`)
        .set(bearer(7))
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty('page');
    }
    expect(service.listTransactions).not.toHaveBeenCalled();

    service.listTransactions.mockResolvedValue({ items: [], page: 10000, limit: 20 });
    await request(app).get('/api/credits/transactions?page=10000').set(bearer(7)).expect(200);
    expect(service.listTransactions).toHaveBeenCalledWith(7, 10000, 20);
  });

  it('token adulterado é recusado como inválido, sem consultar o extrato', async () => {
    const res = await request(app)
      .get('/api/credits/transactions')
      .set('Authorization', 'Bearer nao.e.um.jwt')
      .expect(401);
    expect(res.body.error).toBe('invalid_token');
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('conta suspensa ou banida não vê o extrato, mesmo com token válido (RN-007)', async () => {
    blocklist.add(7);
    try {
      const res = await request(app).get('/api/credits/transactions').set(bearer(7)).expect(403);
      expect(res.body.error).toBe('account_blocked');
      expect(service.listTransactions).not.toHaveBeenCalled();
    } finally {
      blocklist.delete(7);
    }
  });

  it('o extrato só se lê: escrever lançamento pela API não existe', async () => {
    const body = { amount: 9999, reason: 'welcome' };
    const calls = [
      request(app).post('/api/credits/transactions').set(bearer(7)).send(body),
      request(app).put('/api/credits/transactions').set(bearer(7)).send(body),
      request(app).delete('/api/credits/transactions').set(bearer(7)),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    expect(service.listTransactions).not.toHaveBeenCalled();
  });

  it('o extrato é o do token: outro usuário logado recebe o dele', async () => {
    service.listTransactions.mockResolvedValue({ items: [], page: 2, limit: 5 });

    await request(app).get('/api/credits/transactions?page=2&limit=5').set(bearer(31)).expect(200);

    expect(service.listTransactions).toHaveBeenCalledTimes(1);
    expect(service.listTransactions).toHaveBeenCalledWith(31, 2, 5);
  });

  it('se o service falha, a resposta leva o erro dele em JSON (a requisição não fica pendurada)', async () => {
    service.listTransactions.mockRejectedValue(
      new HttpError(503, 'Extrato indisponível', 'ledger_unavailable'),
    );

    const res = await request(app).get('/api/credits/transactions').set(bearer(7)).expect(503);

    expect(res.body).toEqual({ error: 'ledger_unavailable', message: 'Extrato indisponível' });
  });
});
