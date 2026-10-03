import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { walletRoutes } from './wallet.routes';

const { wallet, payments, log } = vi.hoisted(() => ({
  wallet: { getBalance: vi.fn(), listTransactions: vi.fn() },
  payments: {
    createDeposit: vi.fn(),
    listDeposits: vi.fn(),
    getDeposit: vi.fn(),
    simulate: vi.fn(),
  },
  log: vi.fn(),
}));
vi.mock('./wallet.service', () => ({ walletService: wallet }));
vi.mock('../payments/payments.service', () => ({ paymentsService: payments }));
vi.mock('../audit/audit.service', () => ({ auditService: { log } }));

const app = routerApp('/api/wallet', walletRoutes);

const deposit = {
  id: 12,
  amount: 150,
  status: 'pending',
  method: 'pix',
  gateway: 'simulado',
  reference: 'sim_ABC',
  pixCode: '000201...6304ABCD',
  expiresAt: '2026-10-02T15:30:00.000Z',
  paidAt: null,
  createdAt: '2026-10-02T15:00:00.000Z',
  canSimulate: true,
};

/**
 * Rotas da carteira (/api/wallet): saldo, extrato de R$ e os depósitos via PIX, cujos controllers
 * ficam no módulo de pagamentos. Os services entram mockados; aqui se confere a borda HTTP: toda
 * rota exige login, o dono é sempre o do token, o que a validação recusa e o que é auditado.
 */
describe('carteira e depósitos: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('toda rota da carteira exige login', async () => {
    const calls = [
      request(app).get('/api/wallet'),
      request(app).get('/api/wallet/transactions'),
      request(app).post('/api/wallet/deposits').send({ amount: 150 }),
      request(app).get('/api/wallet/deposits'),
      request(app).get('/api/wallet/deposits/12'),
      request(app).post('/api/wallet/deposits/12/simulate'),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    for (const fn of [...Object.values(wallet), ...Object.values(payments)]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('token adulterado é recusado como inválido', async () => {
    const res = await request(app)
      .get('/api/wallet')
      .set('Authorization', 'Bearer nao.e.um.jwt')
      .expect(401);
    expect(res.body.error).toBe('invalid_token');
    expect(wallet.getBalance).not.toHaveBeenCalled();
  });

  it('conta suspensa ou banida não consulta nem movimenta a carteira, mesmo com token válido (RN-007)', async () => {
    blocklist.add(7);
    try {
      const calls = [
        request(app).get('/api/wallet').set(bearer(7)),
        request(app).get('/api/wallet/transactions').set(bearer(7)),
        request(app).post('/api/wallet/deposits').set(bearer(7)).send({ amount: 150 }),
        request(app).get('/api/wallet/deposits').set(bearer(7)),
        request(app).get('/api/wallet/deposits/12').set(bearer(7)),
        request(app).post('/api/wallet/deposits/12/simulate').set(bearer(7)),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
      for (const fn of [...Object.values(wallet), ...Object.values(payments)]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(log).not.toHaveBeenCalled();

      // O bloqueio é da conta, não da rota: outro usuário segue usando a carteira dele.
      wallet.getBalance.mockResolvedValue({ balance: 0 });
      await request(app).get('/api/wallet').set(bearer(8)).expect(200);
      expect(wallet.getBalance).toHaveBeenCalledTimes(1);
      expect(wallet.getBalance).toHaveBeenCalledWith(8);
    } finally {
      blocklist.delete(7);
    }
  });

  describe('GET /api/wallet', () => {
    it('devolve o saldo de quem está logado, ignorando qualquer usuário pedido na URL', async () => {
      const balance = {
        balance: 850,
        balancePending: 150,
        currency: 'BRL',
        credits: 100,
        creditsPending: 0,
      };
      wallet.getBalance.mockResolvedValue(balance);

      const res = await request(app).get('/api/wallet?userId=99').set(bearer(7)).expect(200);

      expect(res.body).toEqual(balance);
      expect(wallet.getBalance).toHaveBeenCalledTimes(1);
      expect(wallet.getBalance).toHaveBeenCalledWith(7);
    });
  });

  describe('GET /api/wallet/transactions', () => {
    it('lista o extrato de quem está logado com a paginação padrão', async () => {
      const page = { items: [{ id: 1, amount: 150, reason: 'deposit' }], page: 1, limit: 20 };
      wallet.listTransactions.mockResolvedValue(page);

      const res = await request(app).get('/api/wallet/transactions').set(bearer(7)).expect(200);

      expect(res.body).toEqual(page);
      expect(wallet.listTransactions).toHaveBeenCalledWith(7, 1, 20);
    });

    it('converte página e limite da URL para número', async () => {
      wallet.listTransactions.mockResolvedValue({ items: [], page: 3, limit: 50 });

      await request(app).get('/api/wallet/transactions?page=3&limit=50').set(bearer(7)).expect(200);

      expect(wallet.listTransactions).toHaveBeenCalledWith(7, 3, 50);
    });

    it('limite acima de 100, página zero ou valor não numérico é erro de validação', async () => {
      const limite = await request(app)
        .get('/api/wallet/transactions?limit=101')
        .set(bearer(7))
        .expect(422);
      expect(limite.body.error).toBe('validation_error');
      expect(limite.body.details).toHaveProperty('limit');
      const pagina = await request(app)
        .get('/api/wallet/transactions?page=0')
        .set(bearer(7))
        .expect(422);
      expect(pagina.body.details).toHaveProperty('page');
      const texto = await request(app)
        .get('/api/wallet/transactions?page=abc')
        .set(bearer(7))
        .expect(422);
      expect(texto.body.error).toBe('validation_error');
      expect(texto.body.details).toHaveProperty('page');
      expect(wallet.listTransactions).not.toHaveBeenCalled();
    });

    it('limite zero ou negativo e página fracionada também são recusados', async () => {
      const cases: [string, string][] = [
        ['limit=0', 'limit'],
        ['limit=-5', 'limit'],
        ['limit=2.5', 'limit'],
        ['page=1.5', 'page'],
        ['page=-1', 'page'],
      ];
      for (const [query, field] of cases) {
        const res = await request(app).get(`/api/wallet/transactions?${query}`).set(bearer(7));
        expect(res.status).toBe(422);
        expect(res.body.details).toHaveProperty(field);
      }
      expect(wallet.listTransactions).not.toHaveBeenCalled();
    });

    it('o limite máximo é 100, e o extrato é o do token mesmo com outro usuário na URL', async () => {
      wallet.listTransactions.mockResolvedValue({ items: [], page: 1, limit: 100 });

      await request(app)
        .get('/api/wallet/transactions?limit=100&userId=99')
        .set(bearer(31))
        .expect(200);

      expect(wallet.listTransactions).toHaveBeenCalledTimes(1);
      expect(wallet.listTransactions).toHaveBeenCalledWith(31, 1, 100);
    });
  });

  describe('POST /api/wallet/deposits', () => {
    it('gera a cobrança em nome de quem está logado, com PIX por padrão, e registra na auditoria', async () => {
      payments.createDeposit.mockResolvedValue(deposit);

      const res = await request(app)
        .post('/api/wallet/deposits')
        .set(bearer(7))
        .set('User-Agent', 'vitest-agent/1.0')
        // userId no corpo não vale nada: o dono do depósito é o do token.
        .send({ amount: 150, userId: 99 })
        .expect(201);

      expect(res.body).toEqual(deposit);
      expect(payments.createDeposit).toHaveBeenCalledTimes(1);
      expect(payments.createDeposit).toHaveBeenCalledWith(7, { amount: 150, method: 'pix' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({
        userId: 7,
        action: 'deposit_created',
        entityType: 'payment',
        entityId: 12,
        newValue: { amount: 150, gateway: 'simulado' },
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: 'vitest-agent/1.0',
      });
    });

    it('aceita os limites exatos: R$ 10,00 e R$ 50.000,00, com centavos', async () => {
      payments.createDeposit.mockResolvedValue(deposit);
      for (const amount of [10, 50_000, 19.99]) {
        await request(app).post('/api/wallet/deposits').set(bearer(7)).send({ amount }).expect(201);
        expect(payments.createDeposit).toHaveBeenLastCalledWith(7, { amount, method: 'pix' });
      }
      expect(payments.createDeposit).toHaveBeenCalledTimes(3);
    });

    it('a auditoria registra a cobrança que o service criou (id, valor e gateway dela)', async () => {
      payments.createDeposit.mockResolvedValue({
        ...deposit,
        id: 77,
        amount: 19.99,
        gateway: 'outro-gateway',
      });

      // O valor pedido é outro de propósito: o que vai para a auditoria é o da cobrança criada.
      await request(app)
        .post('/api/wallet/deposits')
        .set(bearer(31))
        .send({ amount: 20, method: 'pix' })
        .expect(201);

      expect(payments.createDeposit).toHaveBeenCalledWith(31, { amount: 20, method: 'pix' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 31,
          action: 'deposit_created',
          entityType: 'payment',
          entityId: 77,
          newValue: { amount: 19.99, gateway: 'outro-gateway' },
        }),
      );
    });

    it('valor abaixo de R$ 10, acima de R$ 50 mil, com fração de centavo, em texto ou ausente é recusado', async () => {
      for (const amount of [9.99, 50_000.01, 10.005, 0, -20, '150', undefined]) {
        const res = await request(app)
          .post('/api/wallet/deposits')
          .set(bearer(7))
          .send({ amount })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('amount');
      }
      expect(payments.createDeposit).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('a mensagem diz qual limite foi passado', async () => {
      const baixo = await request(app)
        .post('/api/wallet/deposits')
        .set(bearer(7))
        .send({ amount: 5 });
      expect(baixo.body.details.amount).toContain('Depósito mínimo é R$ 10,00');
      const alto = await request(app)
        .post('/api/wallet/deposits')
        .set(bearer(7))
        .send({ amount: 60_000 });
      expect(alto.body.details.amount).toContain('Depósito máximo é R$ 50.000,00');
    });

    it('só PIX é aceito como forma de depósito', async () => {
      const res = await request(app)
        .post('/api/wallet/deposits')
        .set(bearer(7))
        .send({ amount: 150, method: 'credit_card' })
        .expect(422);
      expect(res.body.details).toHaveProperty('method');
      expect(payments.createDeposit).not.toHaveBeenCalled();
    });

    it('se o service falha, a resposta leva o erro dele e nada é auditado', async () => {
      payments.createDeposit.mockRejectedValue(
        new HttpError(502, 'Gateway indisponível', 'gateway_unavailable'),
      );

      const res = await request(app)
        .post('/api/wallet/deposits')
        .set(bearer(7))
        .send({ amount: 150 })
        .expect(502);

      expect(res.body).toEqual({ error: 'gateway_unavailable', message: 'Gateway indisponível' });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/wallet/deposits', () => {
    it('lista os depósitos de quem está logado, com a paginação padrão e a convertida da URL', async () => {
      const page = { items: [deposit], page: 1, limit: 20 };
      payments.listDeposits.mockResolvedValue(page);

      const res = await request(app).get('/api/wallet/deposits').set(bearer(7)).expect(200);
      expect(res.body).toEqual(page);
      expect(payments.listDeposits).toHaveBeenLastCalledWith(7, 1, 20);

      await request(app).get('/api/wallet/deposits?page=2&limit=10').set(bearer(7)).expect(200);
      expect(payments.listDeposits).toHaveBeenLastCalledWith(7, 2, 10);
      // A lista não é confundida com o detalhe (/deposits/:id).
      expect(payments.getDeposit).not.toHaveBeenCalled();
    });

    it('limite acima de 100 é erro de validação', async () => {
      const res = await request(app)
        .get('/api/wallet/deposits?limit=101')
        .set(bearer(7))
        .expect(422);
      expect(res.body.details).toHaveProperty('limit');
      expect(payments.listDeposits).not.toHaveBeenCalled();
    });

    it('página zero, limite zero ou valor que não é número também são recusados', async () => {
      const cases: [string, string][] = [
        ['page=0', 'page'],
        ['page=1.5', 'page'],
        ['page=abc', 'page'],
        ['limit=0', 'limit'],
        ['limit=-1', 'limit'],
      ];
      for (const [query, field] of cases) {
        const res = await request(app).get(`/api/wallet/deposits?${query}`).set(bearer(7));
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty(field);
      }
      expect(payments.listDeposits).not.toHaveBeenCalled();
    });
  });

  describe('falha do service nas leituras', () => {
    // Sem o asyncHandler a promessa rejeitada não chega ao error-handler e a requisição fica
    // pendurada: cada rota de leitura precisa devolver o erro do service em JSON.
    it('saldo, extrato e lista de depósitos devolvem o erro do service em JSON', async () => {
      const boom = () => new HttpError(503, 'Carteira indisponível', 'wallet_unavailable');
      wallet.getBalance.mockRejectedValue(boom());
      wallet.listTransactions.mockRejectedValue(boom());
      payments.listDeposits.mockRejectedValue(boom());

      for (const path of ['/api/wallet', '/api/wallet/transactions', '/api/wallet/deposits']) {
        const res = await request(app).get(path).set(bearer(7));
        expect(res.status).toBe(503);
        expect(res.body).toEqual({
          error: 'wallet_unavailable',
          message: 'Carteira indisponível',
        });
      }
      expect(wallet.getBalance).toHaveBeenCalledWith(7);
      expect(wallet.listTransactions).toHaveBeenCalledWith(7, 1, 20);
      expect(payments.listDeposits).toHaveBeenCalledWith(7, 1, 20);
    });
  });

  describe('GET /api/wallet/deposits/:id', () => {
    it('consulta o depósito pedido em nome de quem está logado (o service confere o dono)', async () => {
      payments.getDeposit.mockResolvedValue(deposit);

      const res = await request(app).get('/api/wallet/deposits/12').set(bearer(7)).expect(200);

      expect(res.body).toEqual(deposit);
      expect(payments.getDeposit).toHaveBeenCalledWith(12, 7);
    });

    it('id que não é inteiro positivo é recusado na validação', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app).get(`/api/wallet/deposits/${id}`).set(bearer(7)).expect(422);
        expect(res.body.details).toHaveProperty('id');
      }
      expect(payments.getDeposit).not.toHaveBeenCalled();
    });

    it('depósito de outra pessoa: o 403 do service vira a resposta', async () => {
      payments.getDeposit.mockRejectedValue(
        new HttpError(403, 'Este depósito não é seu', 'forbidden'),
      );

      const res = await request(app).get('/api/wallet/deposits/12').set(bearer(8)).expect(403);

      expect(res.body).toEqual({ error: 'forbidden', message: 'Este depósito não é seu' });
      expect(payments.getDeposit).toHaveBeenCalledWith(12, 8);
    });

    it('depósito que não existe: o 404 do service vira a resposta', async () => {
      payments.getDeposit.mockRejectedValue(
        new HttpError(404, 'Depósito não encontrado', 'deposit_not_found'),
      );

      const res = await request(app).get('/api/wallet/deposits/999').set(bearer(7)).expect(404);

      expect(res.body).toEqual({ error: 'deposit_not_found', message: 'Depósito não encontrado' });
      expect(payments.getDeposit).toHaveBeenCalledWith(999, 7);
    });

    it('consultar não é simular nem gera auditoria', async () => {
      payments.getDeposit.mockResolvedValue(deposit);

      await request(app).get('/api/wallet/deposits/12').set(bearer(7)).expect(200);

      expect(payments.simulate).not.toHaveBeenCalled();
      expect(payments.listDeposits).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('o que não é rota da carteira', () => {
    it('depósito não se altera nem se apaga pela API, e o saldo não se escreve: 404', async () => {
      const calls = [
        request(app).delete('/api/wallet/deposits/12').set(bearer(7)),
        request(app).put('/api/wallet/deposits/12').set(bearer(7)).send({ status: 'paid' }),
        request(app).patch('/api/wallet/deposits/12').set(bearer(7)).send({ status: 'paid' }),
        request(app).post('/api/wallet').set(bearer(7)).send({ balance: 9999 }),
        request(app).post('/api/wallet/transactions').set(bearer(7)).send({ amount: 9999 }),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      for (const fn of [...Object.values(wallet), ...Object.values(payments)]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/wallet/deposits/:id/simulate', () => {
    it('confirma a cobrança em nome de quem está logado e registra na auditoria', async () => {
      const paid = { ...deposit, status: 'paid', pixCode: null, canSimulate: false };
      payments.simulate.mockResolvedValue(paid);

      const res = await request(app)
        .post('/api/wallet/deposits/12/simulate')
        .set(bearer(7))
        .expect(200);

      expect(res.body).toEqual(paid);
      expect(payments.simulate).toHaveBeenCalledTimes(1);
      expect(payments.simulate).toHaveBeenCalledWith(12, 7);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({
        userId: 7,
        action: 'deposit_simulated',
        entityType: 'payment',
        entityId: 12,
        newValue: { amount: 150 },
        ip: expect.stringContaining('127.0.0.1'),
        // Chamada sem User-Agent: a auditoria grava nulo, não undefined.
        userAgent: null,
      });
    });

    it('com a simulação desligada no ambiente, o 403 do service vira a resposta e nada é auditado', async () => {
      payments.simulate.mockRejectedValue(
        new HttpError(
          403,
          'Simulação de pagamento desligada neste ambiente',
          'simulation_disabled',
        ),
      );

      const res = await request(app)
        .post('/api/wallet/deposits/12/simulate')
        .set(bearer(7))
        .expect(403);

      expect(res.body.error).toBe('simulation_disabled');
      expect(log).not.toHaveBeenCalled();
    });

    it('id inválido é recusado antes de chegar ao service', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app)
          .post(`/api/wallet/deposits/${id}/simulate`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('id');
      }
      expect(payments.simulate).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('a auditoria fica em nome de quem simulou, com o valor da cobrança confirmada', async () => {
      payments.simulate.mockResolvedValue({ ...deposit, id: 77, amount: 19.99, status: 'paid' });

      await request(app)
        .post('/api/wallet/deposits/77/simulate')
        .set(bearer(31))
        .set('User-Agent', 'vitest-agent/1.0')
        .expect(200);

      expect(payments.simulate).toHaveBeenCalledWith(77, 31);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({
        userId: 31,
        action: 'deposit_simulated',
        entityType: 'payment',
        entityId: 77,
        newValue: { amount: 19.99 },
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: 'vitest-agent/1.0',
      });
    });

    it('cobrança vencida ou já liquidada: o 409 do service vira a resposta e nada é auditado', async () => {
      const refusals: [string, string][] = [
        ['deposit_expired', 'Cobrança vencida; gere um novo depósito'],
        ['deposit_not_pending', 'Este depósito já foi liquidado'],
      ];
      for (const [code, message] of refusals) {
        payments.simulate.mockRejectedValueOnce(new HttpError(409, message, code));

        const res = await request(app)
          .post('/api/wallet/deposits/12/simulate')
          .set(bearer(7))
          .expect(409);

        expect(res.body).toEqual({ error: code, message });
      }
      expect(log).not.toHaveBeenCalled();
    });

    it('simular é POST: um GET no mesmo caminho não confirma nada', async () => {
      await request(app).get('/api/wallet/deposits/12/simulate').set(bearer(7)).expect(404);
      expect(payments.simulate).not.toHaveBeenCalled();
    });
  });
});
