import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { contractsRoutes } from './contracts.routes';

const { service, notify, audit } = vi.hoisted(() => ({
  service: {
    create: vi.fn(),
    listMine: vi.fn(),
    getById: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    deliver: vi.fn(),
    approve: vi.fn(),
    requestRevision: vi.fn(),
    cancel: vi.fn(),
    requestExtension: vi.fn(),
    resolveExtension: vi.fn(),
    deliverMilestone: vi.fn(),
    approveMilestone: vi.fn(),
    requestMilestoneRevision: vi.fn(),
  },
  notify: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('./contracts.service', () => ({ contractsService: service }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify },
}));
vi.mock('../audit/audit.service', () => ({ auditService: { log: audit } }));

const app = routerApp('/api/contracts', contractsRoutes);

/** Quem chama nos exemplos: o cliente é o usuário 3 e o freelancer é o 7. */
const CLIENT = 3;
const FREELANCER = 7;

const AGENT = 'vitest-contracts/1.0';
/** De onde veio o pedido, como o controller entrega à auditoria. */
const origin = { ip: expect.stringContaining('127.0.0.1'), userAgent: AGENT };

const proposal = {
  freelancerId: FREELANCER,
  title: 'Landing page',
  description: 'Página de vendas responsiva',
  price: 500,
};

/**
 * Rotas e controllers das contratações: quem pode chamar, o que a validação recusa, o que chega ao
 * service em nome de quem está logado, quem é avisado e o que fica na auditoria. As regras de cada
 * transição (quem pode, em que status) são do service e têm os próprios testes.
 */
describe('contratações: borda HTTP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.mockResolvedValue(undefined);
  });

  describe('acesso', () => {
    const routes: ['get' | 'post', string][] = [
      ['post', '/api/contracts'],
      ['get', '/api/contracts'],
      ['get', '/api/contracts/12'],
      ['post', '/api/contracts/12/accept'],
      ['post', '/api/contracts/12/reject'],
      ['post', '/api/contracts/12/deliver'],
      ['post', '/api/contracts/12/approve'],
      ['post', '/api/contracts/12/request-revision'],
      ['post', '/api/contracts/12/cancel'],
      ['post', '/api/contracts/12/extension'],
      ['post', '/api/contracts/12/extension/accept'],
      ['post', '/api/contracts/12/extension/decline'],
      ['post', '/api/contracts/12/milestones/5/deliver'],
      ['post', '/api/contracts/12/milestones/5/approve'],
      ['post', '/api/contracts/12/milestones/5/request-revision'],
    ];

    it('toda rota exige login, e sem ele nada chega ao service, ao aviso nem à auditoria', async () => {
      for (const [method, url] of routes) {
        const res = await request(app)[method](url);
        expect(res.status, `${method} ${url}`).toBe(401);
        expect(res.body.error).toBe('missing_token');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('token que não é o do login é recusado', async () => {
      const res = await request(app)
        .get('/api/contracts/12')
        .set({ Authorization: 'Bearer nao-e-um-jwt' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('as transições são POST: um GET no mesmo endereço não executa nada', async () => {
      for (const action of ['accept', 'reject', 'approve', 'cancel', 'milestones/5/approve']) {
        const res = await request(app).get(`/api/contracts/12/${action}`).set(bearer(CLIENT));
        expect(res.status, action).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('contratação não se apaga nem se edita pela API: só as transições mudam o estado', async () => {
      for (const method of ['delete', 'put', 'patch'] as const) {
        const call = request(app)[method]('/api/contracts/12');
        const res = await call.set(bearer(CLIENT)).send({ status: 'completed', price: 1 });
        expect(res.status, method).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('o papel no token não muda quem age: um admin logado chega ao service como o próprio usuário', async () => {
      // Não há atalho de admin nas contratações: quem pode o quê é o service que decide, pelo uid.
      service.accept.mockRejectedValueOnce(
        new HttpError(403, 'Ação exclusiva do freelancer', 'forbidden'),
      );
      const res = await request(app)
        .post('/api/contracts/12/accept')
        .set(bearer(99, 'admin'))
        .expect(403);
      expect(res.body).toEqual({ error: 'forbidden', message: 'Ação exclusiva do freelancer' });
      expect(service.accept).toHaveBeenCalledWith(12, 99);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('id da contratação e do marco', () => {
    const deadlineAt = '2026-10-17T02:59:59.000Z';
    /** Cada rota com um corpo válido: o que a validação recusa aqui é só o id. */
    const routes: [string, object][] = [
      ['deliver', { message: 'Pronto' }],
      ['approve', {}],
      ['request-revision', { note: 'Trocar a cor' }],
      ['cancel', {}],
      ['extension', { deadlineAt, reason: 'Material atrasou' }],
      ['extension/accept', {}],
      ['milestones/5/deliver', { message: 'Layout' }],
      ['milestones/5/approve', {}],
      ['milestones/5/request-revision', {}],
    ];

    it('contratação com id que não é inteiro positivo é recusada em toda transição, antes do service', async () => {
      for (const [action, body] of routes) {
        for (const id of ['abc', '0', '-3', '1.5']) {
          const res = await request(app)
            .post(`/api/contracts/${id}/${action}`)
            .set(bearer(CLIENT))
            .send(body);
          expect(res.status, `${id}/${action}`).toBe(422);
          expect(res.body.error).toBe('validation_error');
          expect(res.body.details).toHaveProperty('id');
        }
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('marco com id que não é inteiro positivo é recusado na aprovação e na revisão', async () => {
      for (const action of ['approve', 'request-revision']) {
        for (const milestoneId of ['x', '0', '2.5']) {
          const res = await request(app)
            .post(`/api/contracts/12/milestones/${milestoneId}/${action}`)
            .set(bearer(CLIENT))
            .send({});
          expect(res.status, `${milestoneId}/${action}`).toBe(422);
          expect(res.body.details).toHaveProperty('milestoneId');
          expect(res.body.details).not.toHaveProperty('id');
        }
      }
      expect(service.approveMilestone).not.toHaveBeenCalled();
      expect(service.requestMilestoneRevision).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/contracts', () => {
    it('cria a proposta em nome de quem está logado, em dinheiro quando o modo não vem', async () => {
      service.create.mockResolvedValue({ id: 12, status: 'pending' });
      const res = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send(proposal)
        .expect(201);

      expect(res.body).toEqual({ id: 12, status: 'pending' });
      expect(service.create).toHaveBeenCalledWith(CLIENT, { ...proposal, paymentMode: 'cash' });
      // O aviso da proposta sai do service, com a hora para responder (ADR 57).
      expect(notify).not.toHaveBeenCalled();
    });

    it('abaixo de R$ 10,00 a validação recusa (RN-027)', async () => {
      const res = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send({ ...proposal, price: 9.99 })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details.price).toEqual(['Contratação mínima é R$ 10,00 (RN-027)']);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('valor com fração de centavo é recusado antes do service: 10,005 não cria 1 centavo a cada cancelamento', async () => {
      for (const price of [10.005, 150.001]) {
        const res = await request(app)
          .post('/api/contracts')
          .set(bearer(CLIENT))
          .send({ ...proposal, price })
          .expect(422);
        expect(res.body).toEqual({
          error: 'validation_error',
          message: 'Dados de entrada inválidos',
          details: { price: ['O valor vai até os centavos: no máximo duas casas decimais'] },
        });
      }
      expect(service.create).not.toHaveBeenCalled();

      service.create.mockResolvedValue({ id: 12, status: 'pending' });
      await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send({ ...proposal, price: 10.01 })
        .expect(201);
      expect(service.create).toHaveBeenCalledWith(CLIENT, {
        ...proposal,
        price: 10.01,
        paymentMode: 'cash',
      });
    });

    it('marcos que não somam o valor da contratação são recusados (RN-069)', async () => {
      const res = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send({
          ...proposal,
          milestones: [
            { title: 'Layout', amount: 200 },
            { title: 'Publicação', amount: 200 },
          ],
        })
        .expect(422);
      expect(res.body.details.milestones).toEqual([
        'A soma dos marcos precisa ser igual ao valor da contratação (RN-069)',
      ]);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('a recusa do service (sem saldo para reservar) vira a resposta com o código dele', async () => {
      service.create.mockRejectedValue(
        new HttpError(402, 'Saldo insuficiente', 'insufficient_balance'),
      );
      const res = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send(proposal)
        .expect(402);
      expect(res.body).toEqual({ error: 'insufficient_balance', message: 'Saldo insuficiente' });
    });

    it('serviço pausado: o 409 do service chega com o código e a mensagem da RN-013, sem aviso nem auditoria', async () => {
      service.create.mockRejectedValue(
        new HttpError(
          409,
          'Este serviço está pausado e não aceita novas propostas (RN-013).',
          'service_inactive',
        ),
      );
      const res = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send({ ...proposal, serviceId: 9 })
        .expect(409);
      expect(res.body).toEqual({
        error: 'service_inactive',
        message: 'Este serviço está pausado e não aceita novas propostas (RN-013).',
      });
      // O serviço da proposta chega ao service, que é quem confere se está no ar.
      expect(service.create).toHaveBeenCalledWith(CLIENT, {
        ...proposal,
        serviceId: 9,
        paymentMode: 'cash',
      });
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('freelancer ou serviço que não existe: o 404 do service chega com o código dele', async () => {
      service.create.mockRejectedValueOnce(
        new HttpError(404, 'Freelancer não encontrado', 'freelancer_not_found'),
      );
      const noFreelancer = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send(proposal)
        .expect(404);
      expect(noFreelancer.body).toEqual({
        error: 'freelancer_not_found',
        message: 'Freelancer não encontrado',
      });

      service.create.mockRejectedValueOnce(
        new HttpError(404, 'Serviço não encontrado', 'service_not_found'),
      );
      const noService = await request(app)
        .post('/api/contracts')
        .set(bearer(CLIENT))
        .send({ ...proposal, serviceId: 404 })
        .expect(404);
      expect(noService.body).toEqual({
        error: 'service_not_found',
        message: 'Serviço não encontrado',
      });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/contracts', () => {
    it('lista as contratações de quem está logado, com a paginação padrão', async () => {
      service.listMine.mockResolvedValue({ items: [], page: 1, limit: 20 });
      const res = await request(app).get('/api/contracts').set(bearer(FREELANCER)).expect(200);
      expect(res.body).toEqual({ items: [], page: 1, limit: 20 });
      expect(service.listMine).toHaveBeenCalledWith(FREELANCER, { page: 1, limit: 20 });
    });

    it('página e limite chegam ao service como números', async () => {
      service.listMine.mockResolvedValue({ items: [], page: 3, limit: 50 });
      await request(app).get('/api/contracts?page=3&limit=50').set(bearer(FREELANCER)).expect(200);
      expect(service.listMine).toHaveBeenCalledWith(FREELANCER, { page: 3, limit: 50 });
    });

    it('a falha do service na listagem vira resposta de erro, sem derrubar o pedido', async () => {
      service.listMine.mockRejectedValueOnce(
        new HttpError(503, 'Banco fora do ar', 'db_unavailable'),
      );
      const res = await request(app).get('/api/contracts').set(bearer(FREELANCER)).expect(503);
      expect(res.body).toEqual({ error: 'db_unavailable', message: 'Banco fora do ar' });
    });

    it('limite acima de 100 ou página zero são recusados', async () => {
      const limit = await request(app)
        .get('/api/contracts?limit=101')
        .set(bearer(FREELANCER))
        .expect(422);
      expect(limit.body.details).toHaveProperty('limit');
      const page = await request(app)
        .get('/api/contracts?page=0')
        .set(bearer(FREELANCER))
        .expect(422);
      expect(page.body.details).toHaveProperty('page');
      expect(service.listMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/contracts/:id', () => {
    it('o detalhe é pedido com o id numérico e com quem está logado (o service confere a parte)', async () => {
      service.getById.mockResolvedValue({ id: 12, history: [] });
      const res = await request(app).get('/api/contracts/12').set(bearer(CLIENT)).expect(200);
      expect(res.body).toEqual({ id: 12, history: [] });
      expect(service.getById).toHaveBeenCalledWith(12, CLIENT);
    });

    it('id que não é um inteiro positivo é recusado', async () => {
      for (const id of ['abc', '0', '1.5']) {
        const res = await request(app).get(`/api/contracts/${id}`).set(bearer(CLIENT));
        expect(res.status, id).toBe(422);
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('contratação que não existe, ou de que a pessoa não participa, responde com o erro do service', async () => {
      service.getById.mockRejectedValueOnce(
        new HttpError(404, 'Contratação não encontrada', 'contract_not_found'),
      );
      const missing = await request(app).get('/api/contracts/12').set(bearer(CLIENT)).expect(404);
      expect(missing.body.error).toBe('contract_not_found');

      service.getById.mockRejectedValueOnce(
        new HttpError(403, 'Você não participa desta contratação', 'forbidden'),
      );
      const other = await request(app).get('/api/contracts/12').set(bearer(99)).expect(403);
      expect(other.body).toEqual({
        error: 'forbidden',
        message: 'Você não participa desta contratação',
      });
    });
  });

  describe('aceite e recusa da proposta', () => {
    const contract = { id: 12, clientId: CLIENT, freelancerId: FREELANCER };

    it('o aceite vai em nome de quem está logado e avisa o cliente (RF-032)', async () => {
      service.accept.mockResolvedValue({ ...contract, status: 'accepted' });
      const res = await request(app)
        .post('/api/contracts/12/accept')
        .set(bearer(FREELANCER))
        .expect(200);

      expect(res.body).toEqual({ ...contract, status: 'accepted' });
      expect(service.accept).toHaveBeenCalledWith(12, FREELANCER);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(CLIENT, {
        type: 'contract_accepted',
        title: 'Sua proposta foi aceita',
        data: { contractId: 12 },
      });
    });

    it('a recusa vai em nome de quem está logado e avisa o cliente', async () => {
      service.reject.mockResolvedValue({ ...contract, status: 'rejected' });
      const res = await request(app)
        .post('/api/contracts/12/reject')
        .set(bearer(FREELANCER))
        .expect(200);

      expect(res.body).toEqual({ ...contract, status: 'rejected' });
      expect(service.reject).toHaveBeenCalledWith(12, FREELANCER);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(CLIENT, {
        type: 'contract_rejected',
        title: 'Sua proposta foi recusada',
        data: { contractId: 12 },
      });
    });

    it('quando o service barra (não é o freelancer), ninguém é avisado', async () => {
      const forbidden = new HttpError(403, 'Ação exclusiva do freelancer', 'forbidden');
      service.accept.mockRejectedValue(forbidden);
      service.reject.mockRejectedValue(forbidden);
      for (const action of ['accept', 'reject']) {
        const res = await request(app)
          .post(`/api/contracts/12/${action}`)
          .set(bearer(CLIENT))
          .expect(403);
        expect(res.body.error).toBe('forbidden');
      }
      expect(notify).not.toHaveBeenCalled();
    });

    it('id inválido não chega ao service', async () => {
      await request(app).post('/api/contracts/abc/accept').set(bearer(FREELANCER)).expect(422);
      await request(app).post('/api/contracts/abc/reject').set(bearer(FREELANCER)).expect(422);
      expect(service.accept).not.toHaveBeenCalled();
      expect(service.reject).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/contracts/:id/deliver', () => {
    it('a entrega leva a mensagem e os arquivos; o aviso ao cliente é do service (ADR 57)', async () => {
      const input = { message: 'Pronto', files: ['https://cdn.escambo.test/entrega.zip'] };
      service.deliver.mockResolvedValue({ id: 12, status: 'delivered' });
      const res = await request(app)
        .post('/api/contracts/12/deliver')
        .set(bearer(FREELANCER))
        .send(input)
        .expect(200);

      expect(res.body).toEqual({ id: 12, status: 'delivered' });
      expect(service.deliver).toHaveBeenCalledWith(12, FREELANCER, input);
      expect(notify).not.toHaveBeenCalled();
    });

    it('entrega sem mensagem, com arquivo que não é URL ou com mais de 20 arquivos é recusada', async () => {
      const send = (body: object) =>
        request(app).post('/api/contracts/12/deliver').set(bearer(FREELANCER)).send(body);

      const empty = await send({ message: '' }).expect(422);
      expect(empty.body.details).toHaveProperty('message');
      const notUrl = await send({ message: 'Pronto', files: ['entrega.zip'] }).expect(422);
      expect(notUrl.body.details).toHaveProperty('files');
      const tooMany = await send({
        message: 'Pronto',
        files: Array.from({ length: 21 }, (_, i) => `https://cdn.escambo.test/${i}.png`),
      }).expect(422);
      expect(tooMany.body.details).toHaveProperty('files');
      expect(service.deliver).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/contracts/:id/approve', () => {
    const completed = { id: 12, freelancerId: FREELANCER, freelancerNet: 425, status: 'completed' };

    it('aprova em nome do cliente logado, avisa o freelancer e registra na auditoria o valor liberado', async () => {
      service.approve.mockResolvedValue(completed);
      const res = await request(app)
        .post('/api/contracts/12/approve')
        .set(bearer(CLIENT))
        .set('User-Agent', AGENT)
        .expect(200);

      expect(res.body).toEqual(completed);
      expect(service.approve).toHaveBeenCalledWith(12, CLIENT);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(FREELANCER, {
        type: 'contract_completed',
        title: 'Contratação concluída — pagamento liberado',
        data: { contractId: 12 },
      });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: CLIENT,
        action: 'contract_completed',
        entityType: 'contract',
        entityId: 12,
        newValue: { freelancerNet: 425 },
        ...origin,
      });
    });

    it('sem o cabeçalho do navegador, a auditoria guarda o userAgent como null', async () => {
      service.approve.mockResolvedValue(completed);
      await request(app)
        .post('/api/contracts/12/approve')
        .set(bearer(CLIENT))
        .unset('User-Agent')
        .expect(200);
      expect(audit.mock.calls[0]![0]).toMatchObject({ userId: CLIENT, userAgent: null });
    });

    it('aprovação recusada pelo service não avisa nem entra na auditoria', async () => {
      service.approve.mockRejectedValue(
        new HttpError(409, 'Ação não permitida no status "accepted"', 'invalid_transition'),
      );
      const res = await request(app)
        .post('/api/contracts/12/approve')
        .set(bearer(CLIENT))
        .expect(409);
      expect(res.body.error).toBe('invalid_transition');
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/contracts/:id/request-revision', () => {
    it('a nota do cliente chega ao service; sem nota, vai null', async () => {
      service.requestRevision.mockResolvedValue({ id: 12, status: 'revision_requested' });
      const res = await request(app)
        .post('/api/contracts/12/request-revision')
        .set(bearer(CLIENT))
        .send({ note: 'Trocar a cor do botão' })
        .expect(200);
      expect(res.body).toEqual({ id: 12, status: 'revision_requested' });
      expect(service.requestRevision).toHaveBeenLastCalledWith(12, CLIENT, 'Trocar a cor do botão');

      await request(app)
        .post('/api/contracts/12/request-revision')
        .set(bearer(CLIENT))
        .send({})
        .expect(200);
      expect(service.requestRevision).toHaveBeenLastCalledWith(12, CLIENT, null);
      // O aviso a quem entrega sai do service.
      expect(notify).not.toHaveBeenCalled();
    });

    it('nota com mais de 1000 caracteres é recusada', async () => {
      const res = await request(app)
        .post('/api/contracts/12/request-revision')
        .set(bearer(CLIENT))
        .send({ note: 'x'.repeat(1001) })
        .expect(422);
      expect(res.body.details).toHaveProperty('note');
      expect(service.requestRevision).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/contracts/:id/cancel', () => {
    const result = {
      status: 'cancelled',
      refundPercentage: 50,
      stage: 'early',
      by: 'client',
      refundClient: 250,
      releaseFreelancer: 212.5,
      unit: 'BRL',
    };

    it('cancela com o reembolso que a pessoa viu na tela e registra na auditoria como o dinheiro foi dividido (ADR 57)', async () => {
      service.cancel.mockResolvedValue(result);
      const res = await request(app)
        .post('/api/contracts/12/cancel')
        .set(bearer(CLIENT))
        .set('User-Agent', AGENT)
        .send({ expectedRefund: 250 })
        .expect(200);

      expect(res.body).toEqual(result);
      expect(service.cancel).toHaveBeenCalledWith(12, CLIENT, { expectedRefund: 250 });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: CLIENT,
        action: 'contract_cancelled',
        entityType: 'contract',
        entityId: 12,
        newValue: {
          by: 'client',
          stage: 'early',
          refundPercentage: 50,
          refundClient: 250,
          releaseFreelancer: 212.5,
        },
        ...origin,
      });
      // O aviso à outra parte sai do service (RF-039).
      expect(notify).not.toHaveBeenCalled();
    });

    it('sem corpo, cancela sem conferir valor', async () => {
      service.cancel.mockResolvedValue(result);
      await request(app).post('/api/contracts/12/cancel').set(bearer(FREELANCER)).expect(200);
      expect(service.cancel).toHaveBeenCalledWith(12, FREELANCER, {});
    });

    it('reembolso esperado negativo ou que não é número é recusado', async () => {
      for (const expectedRefund of [-1, '250']) {
        const res = await request(app)
          .post('/api/contracts/12/cancel')
          .set(bearer(CLIENT))
          .send({ expectedRefund })
          .expect(422);
        expect(res.body.details).toHaveProperty('expectedRefund');
      }
      expect(service.cancel).not.toHaveBeenCalled();
    });

    it('se o valor mudou desde que a pessoa abriu, responde 409 e nada entra na auditoria', async () => {
      service.cancel.mockRejectedValue(
        new HttpError(409, 'O valor do cancelamento mudou', 'cancel_quote_changed'),
      );
      const res = await request(app)
        .post('/api/contracts/12/cancel')
        .set(bearer(CLIENT))
        .send({ expectedRefund: 500 })
        .expect(409);
      expect(res.body).toEqual({
        error: 'cancel_quote_changed',
        message: 'O valor do cancelamento mudou',
      });
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('extensão de prazo (RN-028)', () => {
    const deadlineAt = '2026-10-17T02:59:59.000Z';

    it('o pedido leva o novo prazo e o motivo sem os espaços das pontas', async () => {
      service.requestExtension.mockResolvedValue({ id: 12, extension: { status: 'pending' } });
      const res = await request(app)
        .post('/api/contracts/12/extension')
        .set(bearer(FREELANCER))
        .send({ deadlineAt, reason: '  O material chegou depois do combinado  ' })
        .expect(200);

      expect(res.body).toEqual({ id: 12, extension: { status: 'pending' } });
      expect(service.requestExtension).toHaveBeenCalledWith(12, FREELANCER, {
        deadlineAt,
        reason: 'O material chegou depois do combinado',
      });
      // O aviso ao cliente sai do service, com a hora para responder (ADR 57).
      expect(notify).not.toHaveBeenCalled();
    });

    it('motivo com menos de 5 caracteres, ou data que não é um instante ISO, é recusado', async () => {
      const send = (body: object) =>
        request(app).post('/api/contracts/12/extension').set(bearer(FREELANCER)).send(body);

      const short = await send({ deadlineAt, reason: '  oi  ' }).expect(422);
      expect(short.body.details.reason).toEqual(['Explique o motivo em ao menos 5 caracteres']);
      const notInstant = await send({ deadlineAt: '2026-10-16', reason: 'Material atrasou' });
      expect(notInstant.status).toBe(422);
      expect(notInstant.body.details).toHaveProperty('deadlineAt');
      expect(service.requestExtension).not.toHaveBeenCalled();
    });

    it('aceitar leva o número do pedido que o cliente viu (ADR 57)', async () => {
      service.resolveExtension.mockResolvedValue({ id: 12, extension: { status: 'accepted' } });
      const res = await request(app)
        .post('/api/contracts/12/extension/accept')
        .set(bearer(CLIENT))
        .send({ seq: 1 })
        .expect(200);
      expect(res.body).toEqual({ id: 12, extension: { status: 'accepted' } });
      expect(service.resolveExtension).toHaveBeenCalledWith(12, CLIENT, true, 1);
    });

    it('o número de pedido zero (linha de antes do ADR 57) chega como 0, não como "sem número"', async () => {
      service.resolveExtension.mockResolvedValue({ id: 12, extension: { status: 'declined' } });
      await request(app)
        .post('/api/contracts/12/extension/decline')
        .set(bearer(CLIENT))
        .send({ seq: 0 })
        .expect(200);
      expect(service.resolveExtension).toHaveBeenCalledWith(12, CLIENT, false, 0);
    });

    it('recusar sem corpo vai sem número de pedido (null)', async () => {
      service.resolveExtension.mockResolvedValue({ id: 12, extension: { status: 'declined' } });
      await request(app)
        .post('/api/contracts/12/extension/decline')
        .set(bearer(CLIENT))
        .expect(200);
      expect(service.resolveExtension).toHaveBeenCalledWith(12, CLIENT, false, null);
      // Aceite e recusa avisam quem entrega pelo service.
      expect(notify).not.toHaveBeenCalled();
    });

    it('a decisão só pode ser accept ou decline, e o número do pedido vai de 0 a 2', async () => {
      const other = await request(app)
        .post('/api/contracts/12/extension/maybe')
        .set(bearer(CLIENT))
        .expect(422);
      expect(other.body.details).toHaveProperty('decision');
      for (const seq of [3, -1, 1.5, '1']) {
        const res = await request(app)
          .post('/api/contracts/12/extension/accept')
          .set(bearer(CLIENT))
          .send({ seq });
        expect(res.status, String(seq)).toBe(422);
        expect(res.body.details).toHaveProperty('seq');
      }
      expect(service.resolveExtension).not.toHaveBeenCalled();
    });

    it('pedido trocado no meio: o 409 do service chega a quem decidiu', async () => {
      service.resolveExtension.mockRejectedValue(
        new HttpError(409, 'O pedido de extensão mudou', 'extension_changed'),
      );
      const res = await request(app)
        .post('/api/contracts/12/extension/accept')
        .set(bearer(CLIENT))
        .send({ seq: 1 })
        .expect(409);
      expect(res.body.error).toBe('extension_changed');
    });
  });

  describe('marcos (RN-069)', () => {
    const contract = { id: 12, freelancerId: FREELANCER, status: 'in_progress' };

    it('a entrega do marco leva o contrato, o marco, quem entrega e a mensagem', async () => {
      service.deliverMilestone.mockResolvedValue(contract);
      const res = await request(app)
        .post('/api/contracts/12/milestones/5/deliver')
        .set(bearer(FREELANCER))
        .send({ message: 'Layout no Figma' })
        .expect(200);

      expect(res.body).toEqual(contract);
      expect(service.deliverMilestone).toHaveBeenCalledWith(12, 5, FREELANCER, 'Layout no Figma');
      // O aviso ao cliente sai do service, com a hora da aprovação automática (ADR 57).
      expect(notify).not.toHaveBeenCalled();
    });

    it('marco com id inválido ou entrega sem mensagem não chega ao service', async () => {
      const badId = await request(app)
        .post('/api/contracts/12/milestones/x/deliver')
        .set(bearer(FREELANCER))
        .send({ message: 'Layout' })
        .expect(422);
      expect(badId.body.details).toHaveProperty('milestoneId');
      const noMessage = await request(app)
        .post('/api/contracts/12/milestones/5/deliver')
        .set(bearer(FREELANCER))
        .send({})
        .expect(422);
      expect(noMessage.body.details).toHaveProperty('message');
      expect(service.deliverMilestone).not.toHaveBeenCalled();
    });

    it('a entrega do marco não leva arquivos: files é 422 no campo files, em vez de aceito e descartado, e chave desconhecida também é recusada', async () => {
      const withFiles = await request(app)
        .post('/api/contracts/12/milestones/5/deliver')
        .set(bearer(FREELANCER))
        .send({ message: 'Layout no Figma', files: ['https://arquivos.escambo.test/layout.fig'] })
        .expect(422);
      expect(withFiles.body).toEqual({
        error: 'validation_error',
        message: 'Dados de entrada inválidos',
        details: { files: ['A entrega de um marco não leva arquivos: mande pelo chat'] },
      });

      const unknownKey = await request(app)
        .post('/api/contracts/12/milestones/5/deliver')
        .set(bearer(FREELANCER))
        .send({ message: 'Layout no Figma', anexo: 'x' })
        .expect(422);
      expect(unknownKey.body.error).toBe('validation_error');

      expect(service.deliverMilestone).not.toHaveBeenCalled();
    });

    it('aprovar um marco que não é o último avisa o freelancer com o valor liberado em reais e audita o marco', async () => {
      service.approveMilestone.mockResolvedValue({
        contract,
        completed: false,
        net: 283.33,
        title: 'Layout',
        unit: 'BRL',
      });
      const res = await request(app)
        .post('/api/contracts/12/milestones/5/approve')
        .set(bearer(CLIENT))
        .set('User-Agent', AGENT)
        .expect(200);

      // A resposta é a contratação, não o resumo da liberação.
      expect(res.body).toEqual(contract);
      expect(service.approveMilestone).toHaveBeenCalledWith(12, 5, CLIENT);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(FREELANCER, {
        type: 'milestone_approved',
        title: 'Marco aprovado: Layout',
        // O Intl separa o "R$" do valor com um espaço inseparável.
        body: expect.stringMatching(/^R\$\s283,33 liberados na sua carteira\.$/),
        data: { contractId: 12, milestoneId: 5 },
      });
      expect(audit).toHaveBeenCalledWith({
        userId: CLIENT,
        action: 'milestone_approved',
        entityType: 'contract',
        entityId: 12,
        newValue: { milestoneId: 5, net: 283.33 },
        ...origin,
      });
    });

    it('aprovar o último marco avisa e audita como contratação concluída', async () => {
      service.approveMilestone.mockResolvedValue({
        contract: { ...contract, status: 'completed' },
        completed: true,
        net: 283.34,
        title: 'Publicação',
        unit: 'BRL',
      });
      await request(app)
        .post('/api/contracts/12/milestones/6/approve')
        .set(bearer(CLIENT))
        .set('User-Agent', AGENT)
        .expect(200);

      expect(notify).toHaveBeenCalledWith(
        FREELANCER,
        expect.objectContaining({
          type: 'contract_completed',
          title: 'Contratação concluída — último marco liberado',
          data: { contractId: 12, milestoneId: 6 },
        }),
      );
      expect(audit).toHaveBeenCalledWith({
        userId: CLIENT,
        action: 'contract_completed',
        entityType: 'contract',
        entityId: 12,
        newValue: { milestoneId: 6, net: 283.34 },
        ...origin,
      });
    });

    it('em créditos, o aviso diz créditos e não reais', async () => {
      service.approveMilestone.mockResolvedValue({
        contract,
        completed: false,
        net: 20,
        title: 'Visita 1',
        unit: 'credits',
      });
      await request(app)
        .post('/api/contracts/12/milestones/5/approve')
        .set(bearer(CLIENT))
        .expect(200);
      expect(notify).toHaveBeenCalledWith(FREELANCER, {
        type: 'milestone_approved',
        title: 'Marco aprovado: Visita 1',
        body: '20 créditos liberados na sua carteira.',
        data: { contractId: 12, milestoneId: 5 },
      });
    });

    it('o aviso e a auditoria vão para o freelancer e a contratação que o service devolveu', async () => {
      // Ids diferentes dos da rota e de quem chama: nada aqui pode sair do pedido.
      service.approveMilestone.mockResolvedValue({
        contract: { id: 12, freelancerId: 44, status: 'in_progress' },
        completed: false,
        net: 100,
        title: 'Layout',
        unit: 'BRL',
      });
      await request(app)
        .post('/api/contracts/12/milestones/5/approve')
        .set(bearer(CLIENT))
        .expect(200);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0]).toBe(44);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0]![0]).toMatchObject({ userId: CLIENT, entityId: 12 });
    });

    it('marco fora de estado: o 409 do service não avisa nem audita', async () => {
      service.approveMilestone.mockRejectedValue(
        new HttpError(409, 'Este marco não está aguardando aprovação', 'invalid_transition'),
      );
      const res = await request(app)
        .post('/api/contracts/12/milestones/5/approve')
        .set(bearer(CLIENT))
        .expect(409);
      expect(res.body.error).toBe('invalid_transition');
      expect(notify).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('a revisão do marco avisa o freelancer com a nota do cliente', async () => {
      service.requestMilestoneRevision.mockResolvedValue(contract);
      const res = await request(app)
        .post('/api/contracts/12/milestones/5/request-revision')
        .set(bearer(CLIENT))
        .send({ note: 'Ajustar o topo' })
        .expect(200);

      expect(res.body).toEqual(contract);
      expect(service.requestMilestoneRevision).toHaveBeenCalledWith(
        12,
        5,
        CLIENT,
        'Ajustar o topo',
      );
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(FREELANCER, {
        type: 'milestone_revision',
        title: 'Revisão solicitada em um marco',
        body: 'Ajustar o topo',
        data: { contractId: 12, milestoneId: 5 },
      });
    });

    it('revisão sem nota: o service recebe null e o aviso sai sem corpo', async () => {
      service.requestMilestoneRevision.mockResolvedValue(contract);
      await request(app)
        .post('/api/contracts/12/milestones/5/request-revision')
        .set(bearer(CLIENT))
        .send({})
        .expect(200);
      expect(service.requestMilestoneRevision).toHaveBeenCalledWith(12, 5, CLIENT, null);
      expect(notify).toHaveBeenCalledWith(FREELANCER, expect.objectContaining({ body: null }));
    });

    it('revisão recusada pelo service (não é o cliente) não avisa ninguém', async () => {
      service.requestMilestoneRevision.mockRejectedValue(
        new HttpError(403, 'Ação exclusiva do cliente', 'forbidden'),
      );
      await request(app)
        .post('/api/contracts/12/milestones/5/request-revision')
        .set(bearer(FREELANCER))
        .send({ note: 'Ajustar' })
        .expect(403);
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
