import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { cancelWithdrawal, requestWithdrawal } from './withdrawal.controller';
import { withdrawalRoutes } from './withdrawal.routes';

const { service, auditLog } = vi.hoisted(() => ({
  service: { request: vi.fn(), listMine: vi.fn(), cancelMine: vi.fn() },
  auditLog: vi.fn(),
}));
vi.mock('./withdrawal.service', () => ({ withdrawalService: service }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: auditLog } }));

const app = routerApp('/api/withdrawals', withdrawalRoutes);

const withdrawal = {
  id: 42,
  amount: 150.5,
  status: 'requested',
  method: 'pix',
  maskedDestination: '••••test',
  createdAt: '2026-10-01T12:00:00.000Z',
  processedAt: null,
};
const pix = { amount: 150.5, method: 'pix', pixKey: 'chave@escambo.test' };
const bank = {
  amount: 300,
  method: 'bank',
  bankName: 'Banco do Brasil',
  bankAgency: '0001',
  bankAccount: '12345-6',
};
const localIp = expect.stringMatching(/127\.0\.0\.1|::1/);

/** Rotas, controllers e validação dos saques: quem pode chamar, o que é recusado, o que chega ao service. */
describe('saques: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('todas as rotas exigem login', async () => {
    for (const res of [
      await request(app).post('/api/withdrawals').send(pix),
      await request(app).get('/api/withdrawals'),
      await request(app).post('/api/withdrawals/42/cancel'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    // Token que não é o do login (assinatura errada) também não passa.
    for (const res of [
      await request(app)
        .post('/api/withdrawals')
        .set({ Authorization: 'Bearer nao-e-um-jwt' })
        .send(pix),
      await request(app)
        .post('/api/withdrawals/42/cancel')
        .set({ Authorization: 'Bearer nao-e-um-jwt' }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
    }
    expect(service.request).not.toHaveBeenCalled();
    expect(service.listMine).not.toHaveBeenCalled();
    expect(service.cancelMine).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  describe('conta bloqueada pela moderação (RN-007)', () => {
    afterEach(() => blocklist.delete(7));

    it('conta suspensa ou banida não pede, não lista nem cancela saque, mesmo com token ainda válido', async () => {
      blocklist.add(7);
      for (const res of [
        await request(app).post('/api/withdrawals').set(bearer(7)).send(pix),
        await request(app).get('/api/withdrawals').set(bearer(7)),
        await request(app).post('/api/withdrawals/42/cancel').set(bearer(7)),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
      expect(service.request).not.toHaveBeenCalled();
      expect(service.listMine).not.toHaveBeenCalled();
      expect(service.cancelMine).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();

      // O bloqueio é da conta, não da rota: outra pessoa continua passando.
      service.listMine.mockResolvedValue({ items: [], page: 1, limit: 20 });
      await request(app).get('/api/withdrawals').set(bearer(44)).expect(200);
      expect(service.listMine).toHaveBeenCalledWith(44, { page: 1, limit: 20 });
    });
  });

  describe('POST /api/withdrawals', () => {
    it('pede o saque por PIX em nome de quem está logado e devolve 201 com ele', async () => {
      service.request.mockResolvedValue(withdrawal);

      const res = await request(app).post('/api/withdrawals').set(bearer(7)).send(pix).expect(201);

      expect(res.body).toEqual(withdrawal);
      expect(service.request).toHaveBeenCalledTimes(1);
      expect(service.request).toHaveBeenCalledWith(7, pix);
    });

    it('pede o saque por conta bancária com os três dados do banco', async () => {
      service.request.mockResolvedValue({ ...withdrawal, method: 'bank' });
      await request(app).post('/api/withdrawals').set(bearer(7)).send(bank).expect(201);
      expect(service.request).toHaveBeenCalledWith(7, bank);
    });

    it('registra o pedido na auditoria com o valor e o método, sem o destino (RN-010)', async () => {
      service.request.mockResolvedValue(withdrawal);

      await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .set('User-Agent', 'vitest-agent/1.0')
        .send(pix)
        .expect(201);

      expect(auditLog).toHaveBeenCalledTimes(1);
      // newValue tem só o valor e o método: a chave PIX não vai para o log de auditoria.
      expect(auditLog).toHaveBeenCalledWith({
        userId: 7,
        action: 'withdrawal_requested',
        entityType: 'withdrawal',
        entityId: 42,
        newValue: { amount: 150.5, method: 'pix' },
        ip: localIp,
        userAgent: 'vitest-agent/1.0',
      });
    });

    it('a resposta não espera a auditoria: o saque já criado é devolvido mesmo com o registro pendente (RN-010)', async () => {
      service.request.mockResolvedValue(withdrawal);
      // Gravação da auditoria que nunca termina (banco lento): quem pediu o saque não fica esperando.
      auditLog.mockReturnValueOnce(new Promise<void>(() => undefined));

      const res = await request(app).post('/api/withdrawals').set(bearer(7)).send(pix).expect(201);

      expect(res.body).toEqual(withdrawal);
      expect(auditLog).toHaveBeenCalledTimes(1);
    });

    it('sem User-Agent, a auditoria guarda null no lugar dele', async () => {
      service.request.mockResolvedValue(withdrawal);
      await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .unset('User-Agent')
        .send(pix)
        .expect(201);
      expect(auditLog.mock.calls[0]![0]).toMatchObject({ userAgent: null });
    });

    it('o valor precisa ser um número positivo (texto não é convertido)', async () => {
      for (const amount of [0, -10, '100', null, undefined]) {
        const res = await request(app)
          .post('/api/withdrawals')
          .set(bearer(7))
          .send({ ...pix, amount })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('amount');
      }
      expect(service.request).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('o método é pix ou bank', async () => {
      for (const method of ['boleto', 'PIX', undefined]) {
        const res = await request(app)
          .post('/api/withdrawals')
          .set(bearer(7))
          .send({ ...pix, method })
          .expect(422);
        expect(res.body.details).toHaveProperty('method');
      }
      expect(service.request).not.toHaveBeenCalled();
    });

    it('saque por PIX sem a chave (ausente, nula ou vazia) é recusado', async () => {
      for (const pixKey of [undefined, null]) {
        const res = await request(app)
          .post('/api/withdrawals')
          .set(bearer(7))
          .send({ amount: 100, method: 'pix', pixKey })
          .expect(422);
        expect(res.body.details).toEqual({ pixKey: ['Chave PIX obrigatória'] });
      }
      const empty = await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .send({ amount: 100, method: 'pix', pixKey: '' })
        .expect(422);
      expect(empty.body.details).toHaveProperty('pixKey');
      // Dados bancários não substituem a chave no saque por PIX.
      const withBank = await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .send({ ...bank, method: 'pix' })
        .expect(422);
      expect(withBank.body.details).toEqual({ pixKey: ['Chave PIX obrigatória'] });
      expect(service.request).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('saque por conta bancária sem banco, agência ou conta é recusado', async () => {
      for (const missing of ['bankName', 'bankAgency', 'bankAccount'] as const) {
        for (const value of [undefined, null, '']) {
          const res = await request(app)
            .post('/api/withdrawals')
            .set(bearer(7))
            .send({ ...bank, [missing]: value })
            .expect(422);
          expect(res.body.details).toEqual({ bankAccount: ['Dados bancários obrigatórios'] });
        }
      }
      // A chave PIX não substitui os dados da conta no saque bancário.
      const withPix = await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .send({ ...pix, method: 'bank' })
        .expect(422);
      expect(withPix.body.details).toEqual({ bankAccount: ['Dados bancários obrigatórios'] });
      expect(service.request).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('corpo vazio ou ausente é recusado apontando o valor e o método', async () => {
      for (const send of [{}, undefined]) {
        const res = await request(app)
          .post('/api/withdrawals')
          .set(bearer(7))
          .send(send)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details).sort()).toEqual(['amount', 'method']);
      }
      expect(service.request).not.toHaveBeenCalled();
    });

    it('os campos de destino precisam ser texto: número não é convertido', async () => {
      const wrongType: [Record<string, unknown>, string][] = [
        [{ ...pix, pixKey: 11999990000 }, 'pixKey'],
        [{ ...bank, bankAgency: 1 }, 'bankAgency'],
        [{ ...bank, bankAccount: 123456 }, 'bankAccount'],
      ];
      for (const [payload, field] of wrongType) {
        const res = await request(app)
          .post('/api/withdrawals')
          .set(bearer(7))
          .send(payload)
          .expect(422);
        expect(res.body.details).toHaveProperty(field);
      }
      expect(service.request).not.toHaveBeenCalled();
    });

    it('os campos do outro método podem vir nulos (o formulário manda todos)', async () => {
      service.request.mockResolvedValue(withdrawal);
      const pixWithNulls = { ...pix, bankName: null, bankAgency: null, bankAccount: null };
      await request(app).post('/api/withdrawals').set(bearer(7)).send(pixWithNulls).expect(201);
      expect(service.request).toHaveBeenLastCalledWith(7, pixWithNulls);

      const bankWithNull = { ...bank, pixKey: null };
      await request(app).post('/api/withdrawals').set(bearer(7)).send(bankWithNull).expect(201);
      expect(service.request).toHaveBeenLastCalledWith(7, bankWithNull);
    });

    it('os campos de destino têm tamanho máximo: chave 255, banco 100, agência 10, conta 20', async () => {
      const tooLong: [Record<string, unknown>, string][] = [
        [{ ...pix, pixKey: 'k'.repeat(256) }, 'pixKey'],
        [{ ...bank, bankName: 'b'.repeat(101) }, 'bankName'],
        [{ ...bank, bankAgency: '1'.repeat(11) }, 'bankAgency'],
        [{ ...bank, bankAccount: '1'.repeat(21) }, 'bankAccount'],
      ];
      for (const [payload, field] of tooLong) {
        const res = await request(app)
          .post('/api/withdrawals')
          .set(bearer(7))
          .send(payload)
          .expect(422);
        expect(res.body.details).toHaveProperty(field);
      }
      expect(service.request).not.toHaveBeenCalled();

      // No limite, passa.
      service.request.mockResolvedValue(withdrawal);
      const atLimit = {
        amount: 300,
        method: 'bank',
        bankName: 'b'.repeat(100),
        bankAgency: '1'.repeat(10),
        bankAccount: '1'.repeat(20),
      };
      await request(app).post('/api/withdrawals').set(bearer(7)).send(atLimit).expect(201);
      expect(service.request).toHaveBeenLastCalledWith(7, atLimit);
      await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .send({ ...pix, pixKey: 'k'.repeat(255) })
        .expect(201);
    });

    it('campo fora do contrato da rota (dono, status) não chega ao service', async () => {
      service.request.mockResolvedValue(withdrawal);
      await request(app)
        .post('/api/withdrawals')
        .set(bearer(7))
        .send({ ...pix, userId: 99, status: 'completed' })
        .expect(201);
      expect(service.request).toHaveBeenCalledWith(7, pix);
    });

    it('a recusa do service (mínimo, e-mail, saldo) vira a resposta com o código dele, sem auditoria', async () => {
      const refusals = [
        new HttpError(422, 'Saque mínimo é R$ 20,00 (RN-034)', 'below_minimum'),
        new HttpError(403, 'Confirme seu e-mail para sacar', 'email_not_verified'),
        new HttpError(400, 'Saldo insuficiente para o saque', 'insufficient_balance'),
      ];
      for (const refusal of refusals) {
        service.request.mockRejectedValueOnce(refusal);
        const res = await request(app).post('/api/withdrawals').set(bearer(7)).send(pix);
        expect(res.status).toBe(refusal.statusCode);
        expect(res.body).toEqual({ error: refusal.code, message: refusal.message });
      }
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/withdrawals', () => {
    it('lista os saques de quem está logado, com a paginação padrão', async () => {
      const page = { items: [withdrawal], page: 1, limit: 20 };
      service.listMine.mockResolvedValue(page);

      const res = await request(app).get('/api/withdrawals').set(bearer(7)).expect(200);

      expect(res.body).toEqual(page);
      expect(service.listMine).toHaveBeenCalledTimes(1);
      expect(service.listMine).toHaveBeenCalledWith(7, { page: 1, limit: 20 });
    });

    it('página e limite da URL chegam convertidos em número', async () => {
      service.listMine.mockResolvedValue({ items: [], page: 3, limit: 100 });
      await request(app).get('/api/withdrawals?page=3&limit=100').set(bearer(7)).expect(200);
      expect(service.listMine).toHaveBeenCalledWith(7, { page: 3, limit: 100 });
    });

    it('filtro de dono ou de status na URL não troca de quem é a lista nem chega ao service', async () => {
      service.listMine.mockResolvedValue({ items: [], page: 2, limit: 20 });
      const res = await request(app)
        .get('/api/withdrawals?page=2&userId=99&status=completed')
        .set(bearer(7))
        .expect(200);
      // Página sem saques vem com a lista vazia (e não erro).
      expect(res.body).toEqual({ items: [], page: 2, limit: 20 });
      // Só página e limite passam pela validação; o limite ausente cai no padrão.
      expect(service.listMine.mock.calls).toEqual([[7, { page: 2, limit: 20 }]]);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('limite acima de 100, página zero ou valores não numéricos são erro de validação', async () => {
      const bad: [string, string][] = [
        ['limit=101', 'limit'],
        ['limit=0', 'limit'],
        ['limit=abc', 'limit'],
        ['page=0', 'page'],
        ['page=-1', 'page'],
        ['page=1.5', 'page'],
      ];
      for (const [query, field] of bad) {
        const res = await request(app).get(`/api/withdrawals?${query}`).set(bearer(7)).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty(field);
      }
      expect(service.listMine).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/withdrawals/:id/cancel', () => {
    it('cancela o saque em nome de quem está logado e devolve o saque atualizado', async () => {
      const cancelled = { ...withdrawal, status: 'cancelled' };
      service.cancelMine.mockResolvedValue(cancelled);

      const res = await request(app).post('/api/withdrawals/42/cancel').set(bearer(7)).expect(200);

      expect(res.body).toEqual(cancelled);
      expect(service.cancelMine).toHaveBeenCalledTimes(1);
      expect(service.cancelMine).toHaveBeenCalledWith(42, 7);
    });

    it('registra o cancelamento na auditoria com o id do saque (RN-010)', async () => {
      service.cancelMine.mockResolvedValue({ ...withdrawal, status: 'cancelled' });

      await request(app)
        .post('/api/withdrawals/42/cancel')
        .set(bearer(7))
        .set('User-Agent', 'vitest-agent/1.0')
        .expect(200);

      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith({
        userId: 7,
        action: 'withdrawal_cancelled',
        entityType: 'withdrawal',
        entityId: 42,
        ip: localIp,
        userAgent: 'vitest-agent/1.0',
      });

      auditLog.mockClear();
      await request(app)
        .post('/api/withdrawals/42/cancel')
        .set(bearer(7))
        .unset('User-Agent')
        .expect(200);
      expect(auditLog.mock.calls[0]![0]).toMatchObject({ userAgent: null });
    });

    it('a resposta do cancelamento não espera a auditoria terminar (RN-010)', async () => {
      const cancelled = { ...withdrawal, status: 'cancelled' };
      service.cancelMine.mockResolvedValue(cancelled);
      auditLog.mockReturnValueOnce(new Promise<void>(() => undefined));

      const res = await request(app).post('/api/withdrawals/42/cancel').set(bearer(7)).expect(200);

      expect(res.body).toEqual(cancelled);
      expect(auditLog).toHaveBeenCalledTimes(1);
    });

    it('sem IP conhecido (conexão já encerrada quando o controller roda), a auditoria guarda null no pedido e no cancelamento', async () => {
      // Com o supertest o req.ip vem sempre preenchido: aqui os controllers são chamados direto.
      const user = { sub: 'ulid-7', uid: 7, role: 'freelancer' };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      service.request.mockResolvedValue(withdrawal);
      await requestWithdrawal(
        { body: pix, headers: {}, user } as unknown as Request,
        res as unknown as Response,
      );
      expect(auditLog).toHaveBeenLastCalledWith({
        userId: 7,
        action: 'withdrawal_requested',
        entityType: 'withdrawal',
        entityId: 42,
        newValue: { amount: 150.5, method: 'pix' },
        ip: null,
        userAgent: null,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenLastCalledWith(withdrawal);

      const cancelled = { ...withdrawal, status: 'cancelled' };
      service.cancelMine.mockResolvedValue(cancelled);
      await cancelWithdrawal(
        { params: { id: '42' }, headers: {}, user } as unknown as Request,
        res as unknown as Response,
      );
      expect(auditLog).toHaveBeenLastCalledWith({
        userId: 7,
        action: 'withdrawal_cancelled',
        entityType: 'withdrawal',
        entityId: 42,
        ip: null,
        userAgent: null,
      });
      expect(res.json).toHaveBeenLastCalledWith(cancelled);
      expect(service.cancelMine).toHaveBeenCalledWith(42, 7);
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app)
          .post(`/api/withdrawals/${id}/cancel`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.cancelMine).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('saque de outra pessoa, inexistente ou já em processamento: a recusa do service passa, sem auditoria', async () => {
      const refusals = [
        new HttpError(403, 'Este saque não é seu', 'forbidden'),
        new HttpError(404, 'Saque não encontrado', 'withdrawal_not_found'),
        new HttpError(409, 'O saque já está em processamento ou encerrado', 'invalid_transition'),
      ];
      for (const refusal of refusals) {
        service.cancelMine.mockRejectedValueOnce(refusal);
        const res = await request(app).post('/api/withdrawals/42/cancel').set(bearer(99));
        expect(res.status).toBe(refusal.statusCode);
        expect(res.body).toEqual({ error: refusal.code, message: refusal.message });
      }
      expect(service.cancelMine).toHaveBeenCalledWith(42, 99);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('cancelar é POST em /:id/cancel: o titular não apaga nem edita o saque por outro caminho', async () => {
      for (const res of [
        await request(app).delete('/api/withdrawals/42').set(bearer(7)),
        await request(app)
          .patch('/api/withdrawals/42')
          .set(bearer(7))
          .send({ status: 'cancelled' }),
        await request(app).get('/api/withdrawals/42/cancel').set(bearer(7)),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      expect(service.cancelMine).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  it('falha inesperada do service vira 500 genérico, sem vazar a mensagem interna nem auditar', async () => {
    service.listMine.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3306'));
    const res = await request(app).get('/api/withdrawals').set(bearer(7)).expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    expect(auditLog).not.toHaveBeenCalled();
  });
});
