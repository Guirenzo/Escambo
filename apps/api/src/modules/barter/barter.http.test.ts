import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { barterRoutes } from './barter.routes';

const { service, notify } = vi.hoisted(() => ({
  service: {
    propose: vi.fn(),
    listMine: vi.fn(),
    getById: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
  notify: vi.fn(),
}));
vi.mock('./barter.service', () => ({ barterService: service }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify },
}));

const app = routerApp('/api/barters', barterRoutes);

/** Proposta válida mínima: os dois lados descritos em texto, sem serviço do catálogo. */
const proposal = {
  receiverId: 2,
  offeredDescription: 'Logo da marca',
  requestedDescription: 'Landing page',
  estimatedValueOffered: 1000,
  estimatedValueRequested: 800,
};

/** Rotas e controllers das trocas: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('trocas: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('todas as rotas exigem login', () => {
    const routes = [
      ['post', '/api/barters'],
      ['get', '/api/barters'],
      ['get', '/api/barters/5'],
      ['post', '/api/barters/5/accept'],
      ['post', '/api/barters/5/reject'],
      ['post', '/api/barters/5/cancel'],
    ] as const;

    it.each(routes)('%s %s sem token é 401 e não chega ao service', async (method, path) => {
      const res = await request(app)[method](path).send(proposal);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('token que não foi assinado pela API é recusado', async () => {
      const res = await request(app).get('/api/barters').set({ Authorization: 'Bearer forjado' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.listMine).not.toHaveBeenCalled();
    });

    it.each(routes)(
      '%s %s com conta suspensa ou banida é 403 mesmo com token válido (RN-007)',
      async (method, path) => {
        blocklist.add(7);
        try {
          const res = await request(app)[method](path).set(bearer(7)).send(proposal);
          expect(res.status).toBe(403);
          expect(res.body.error).toBe('account_blocked');
        } finally {
          blocklist.delete(7);
        }
        for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      },
    );
  });

  describe('o que a API de trocas não oferece', () => {
    it('não há rota para editar nem apagar uma troca, e aceitar, recusar e cancelar só por POST', async () => {
      const absent = [
        ['put', '/api/barters/5'],
        ['patch', '/api/barters/5'],
        ['delete', '/api/barters/5'],
        ['get', '/api/barters/5/accept'],
        ['get', '/api/barters/5/reject'],
        ['get', '/api/barters/5/cancel'],
      ] as const;
      for (const [method, path] of absent) {
        const res = await request(app)[method](path).set(bearer(7));
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/barters', () => {
    it('propõe em nome de quem está logado, responde 201 e avisa quem recebeu a proposta', async () => {
      const barter = { id: 9, proposerId: 7, receiverId: 2, status: 'proposed' };
      service.propose.mockResolvedValue(barter);

      const res = await request(app).post('/api/barters').set(bearer(7)).send(proposal).expect(201);

      expect(res.body).toEqual(barter);
      expect(service.propose).toHaveBeenCalledTimes(1);
      expect(service.propose).toHaveBeenCalledWith(7, proposal);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(2, {
        type: 'barter_proposed',
        title: 'Nova proposta de troca de serviços',
        data: { barterId: 9 },
      });
    });

    it('o proponente é quem está logado: campos que o corpo não pode escolher são descartados', async () => {
      service.propose.mockResolvedValue({ id: 9, receiverId: 2 });
      await request(app)
        .post('/api/barters')
        .set(bearer(7))
        .send({ ...proposal, proposerId: 99, cashPayerId: 2, platformFee: 0, status: 'active' })
        .expect(201);
      expect(service.propose).toHaveBeenCalledWith(7, proposal);
    });

    it('cada lado pode ser um serviço do catálogo em vez de uma descrição', async () => {
      service.propose.mockResolvedValue({ id: 9, receiverId: 2 });
      const body = {
        receiverId: 2,
        offeredServiceId: 31,
        offeredDescription: null,
        requestedServiceId: 32,
        estimatedValueOffered: 150.5,
        estimatedValueRequested: 150.5,
      };
      await request(app).post('/api/barters').set(bearer(7)).send(body).expect(201);
      expect(service.propose).toHaveBeenCalledWith(7, body);
    });

    it('sem serviço nem descrição do que se oferece, ou do que se pede, é erro de validação', async () => {
      const semOferta = await request(app)
        .post('/api/barters')
        .set(bearer(7))
        .send({ ...proposal, offeredDescription: undefined, offeredServiceId: null })
        .expect(422);
      expect(semOferta.body.error).toBe('validation_error');
      expect(semOferta.body.details).toEqual({
        offeredServiceId: ['Informe um serviço ou descrição do que você oferece'],
      });

      const semPedido = await request(app)
        .post('/api/barters')
        .set(bearer(7))
        .send({ ...proposal, requestedDescription: null })
        .expect(422);
      expect(semPedido.body.details).toEqual({
        requestedServiceId: ['Informe um serviço ou descrição do que você quer em troca'],
      });

      expect(service.propose).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('faltando os dois lados, a resposta aponta os dois de uma vez', async () => {
      const res = await request(app)
        .post('/api/barters')
        .set(bearer(7))
        .send({ receiverId: 2, estimatedValueOffered: 1000, estimatedValueRequested: 800 })
        .expect(422);
      expect(res.body).toEqual({
        error: 'validation_error',
        message: 'Dados de entrada inválidos',
        details: {
          offeredServiceId: ['Informe um serviço ou descrição do que você oferece'],
          requestedServiceId: ['Informe um serviço ou descrição do que você quer em troca'],
        },
      });
      expect(service.propose).not.toHaveBeenCalled();
    });

    it('serviço nulo com descrição vale dos dois lados, e o nulo chega ao service como veio', async () => {
      service.propose.mockResolvedValue({ id: 9, receiverId: 2 });
      const body = { ...proposal, offeredServiceId: null, requestedServiceId: null };
      await request(app).post('/api/barters').set(bearer(7)).send(body).expect(201);
      expect(service.propose).toHaveBeenCalledWith(7, body);
    });

    it('destinatário, valores e descrições fora do formato são recusados campo a campo', async () => {
      const invalid: Array<[string, Record<string, unknown>]> = [
        ['receiverId', { receiverId: undefined }],
        ['receiverId', { receiverId: 0 }],
        ['receiverId', { receiverId: 2.5 }],
        // Sem conversão no corpo JSON: número em texto não vale.
        ['receiverId', { receiverId: '2' }],
        ['receiverId', { receiverId: -2 }],
        ['receiverId', { receiverId: null }],
        ['offeredServiceId', { offeredServiceId: -1 }],
        ['offeredServiceId', { offeredServiceId: 1.5 }],
        ['offeredServiceId', { offeredServiceId: '31' }],
        // Zero passaria pelo "serviço ou descrição" (a descrição veio): quem barra é o positivo.
        ['offeredServiceId', { offeredServiceId: 0 }],
        ['requestedServiceId', { requestedServiceId: 1.5 }],
        ['requestedServiceId', { requestedServiceId: 0 }],
        ['requestedServiceId', { requestedServiceId: -1 }],
        ['requestedServiceId', { requestedServiceId: '32' }],
        ['estimatedValueOffered', { estimatedValueOffered: 0 }],
        ['estimatedValueOffered', { estimatedValueOffered: -0.01 }],
        ['estimatedValueOffered', { estimatedValueOffered: '1000' }],
        ['estimatedValueOffered', { estimatedValueOffered: undefined }],
        ['estimatedValueOffered', { estimatedValueOffered: null }],
        ['estimatedValueRequested', { estimatedValueRequested: 0 }],
        ['estimatedValueRequested', { estimatedValueRequested: -10 }],
        ['estimatedValueRequested', { estimatedValueRequested: undefined }],
        ['estimatedValueRequested', { estimatedValueRequested: '800' }],
        ['offeredDescription', { offeredDescription: 'ab' }],
        ['offeredDescription', { offeredDescription: 'x'.repeat(1001) }],
        ['offeredDescription', { offeredDescription: 123 }],
        ['requestedDescription', { requestedDescription: 'ab' }],
        ['requestedDescription', { requestedDescription: 'x'.repeat(1001) }],
        ['requestedDescription', { requestedDescription: 123 }],
      ];
      for (const [field, override] of invalid) {
        const res = await request(app)
          .post('/api/barters')
          .set(bearer(7))
          .send({ ...proposal, ...override });
        expect(res.status, `${field} = ${JSON.stringify(override)}`).toBe(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual([field]);
      }
      expect(service.propose).not.toHaveBeenCalled();
    });

    it('corpo vazio é erro de validação apontando o destinatário e os dois valores', async () => {
      const res = await request(app).post('/api/barters').set(bearer(7)).send({}).expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details).sort()).toEqual([
        'estimatedValueOffered',
        'estimatedValueRequested',
        'receiverId',
      ]);
      expect(service.propose).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('o aviso da proposta vai para o destinatário que o service devolveu, não para o do corpo', async () => {
      // O acordo gravado é a fonte: se o service devolve outro receptor, é ele quem é avisado.
      service.propose.mockResolvedValue({ id: 12, proposerId: 7, receiverId: 3 });
      await request(app).post('/api/barters').set(bearer(7)).send(proposal).expect(201);
      expect(notify.mock.calls).toEqual([
        [
          3,
          {
            type: 'barter_proposed',
            title: 'Nova proposta de troca de serviços',
            data: { barterId: 12 },
          },
        ],
      ]);
    });

    it('descrição nos limites (3 e 1000 caracteres) e valor com centavos passam', async () => {
      service.propose.mockResolvedValue({ id: 9, receiverId: 2 });
      const body = {
        ...proposal,
        offeredDescription: 'abc',
        requestedDescription: 'x'.repeat(1000),
        estimatedValueOffered: 0.01,
      };
      await request(app).post('/api/barters').set(bearer(7)).send(body).expect(201);
      expect(service.propose).toHaveBeenCalledWith(7, body);
    });

    it('a recusa do service vira a resposta com o código dele, e ninguém é avisado', async () => {
      service.propose.mockRejectedValue(
        new HttpError(402, 'Saldo insuficiente para reservar a torna', 'insufficient_balance'),
      );
      const res = await request(app).post('/api/barters').set(bearer(7)).send(proposal).expect(402);
      expect(res.body).toEqual({
        error: 'insufficient_balance',
        message: 'Saldo insuficiente para reservar a torna',
      });
      expect(notify).not.toHaveBeenCalled();
    });

    it('falha inesperada do service vira 500 sem vazar o erro (RNF-039)', async () => {
      service.propose.mockRejectedValue(new Error('ER_LOCK_DEADLOCK na tabela wallets'));
      const res = await request(app).post('/api/barters').set(bearer(7)).send(proposal).expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/barters', () => {
    it('lista as trocas de quem está logado, com a paginação padrão', async () => {
      const page = { items: [{ id: 9 }], page: 1, limit: 20 };
      service.listMine.mockResolvedValue(page);
      const res = await request(app).get('/api/barters').set(bearer(7)).expect(200);
      expect(res.body).toEqual(page);
      expect(service.listMine).toHaveBeenCalledWith(7, { page: 1, limit: 20 });
    });

    it('página e limite da URL chegam como números, e o limite vai até 100', async () => {
      service.listMine.mockResolvedValue({ items: [], page: 3, limit: 100 });
      await request(app).get('/api/barters?page=3&limit=100').set(bearer(7)).expect(200);
      expect(service.listMine).toHaveBeenCalledWith(7, { page: 3, limit: 100 });
    });

    it('só a página na URL: o limite continua o padrão, e parâmetro desconhecido não chega ao service', async () => {
      service.listMine.mockResolvedValue({ items: [], page: 2, limit: 20 });
      await request(app).get('/api/barters?page=2&userId=99&offset=500').set(bearer(7)).expect(200);
      expect(service.listMine).toHaveBeenCalledTimes(1);
      expect(service.listMine).toHaveBeenCalledWith(7, { page: 2, limit: 20 });
    });

    it('limite acima de 100, página zero ou valor não numérico são erro de validação', async () => {
      const cases: Array<[string, string]> = [
        ['limit=101', 'limit'],
        ['limit=0', 'limit'],
        ['limit=-5', 'limit'],
        ['limit=1.5', 'limit'],
        ['limit=abc', 'limit'],
        ['page=0', 'page'],
        ['page=-1', 'page'],
        ['page=abc', 'page'],
        ['page=1.5', 'page'],
      ];
      for (const [qs, field] of cases) {
        const res = await request(app).get(`/api/barters?${qs}`).set(bearer(7));
        expect(res.status, qs).toBe(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details), qs).toEqual([field]);
      }
      expect(service.listMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/barters/:id', () => {
    it('busca a troca pelo id numérico, em nome de quem está logado', async () => {
      service.getById.mockResolvedValue({ id: 5, status: 'proposed' });
      const res = await request(app).get('/api/barters/5').set(bearer(7)).expect(200);
      expect(res.body).toEqual({ id: 5, status: 'proposed' });
      expect(service.getById).toHaveBeenCalledWith(5, 7);
    });

    it('id que não é inteiro positivo é erro de validação', async () => {
      // '5abc' não pode virar 5: o id é convertido inteiro, não lido até onde der.
      for (const id of ['abc', '0', '-3', '1.5', '5abc']) {
        const res = await request(app).get(`/api/barters/${id}`).set(bearer(7));
        expect(res.status, id).toBe(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details), id).toEqual(['id']);
      }
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('quem não participa recebe o 403 do service, e troca inexistente o 404', async () => {
      service.getById.mockRejectedValueOnce(
        new HttpError(403, 'Você não participa desta troca', 'forbidden'),
      );
      const forbidden = await request(app).get('/api/barters/5').set(bearer(99)).expect(403);
      expect(forbidden.body).toEqual({
        error: 'forbidden',
        message: 'Você não participa desta troca',
      });

      service.getById.mockRejectedValueOnce(
        new HttpError(404, 'Troca não encontrada', 'barter_not_found'),
      );
      const missing = await request(app).get('/api/barters/5').set(bearer(7)).expect(404);
      expect(missing.body.error).toBe('barter_not_found');
    });
  });

  describe('POST /api/barters/:id/accept', () => {
    it('aceita em nome de quem está logado, devolve a troca e avisa o proponente (RN-067)', async () => {
      const barter = { id: 5, proposerId: 1, receiverId: 7, status: 'active' };
      service.accept.mockResolvedValue(barter);

      const res = await request(app).post('/api/barters/5/accept').set(bearer(7)).expect(200);

      expect(res.body).toEqual(barter);
      expect(service.accept).toHaveBeenCalledWith(5, 7);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(1, {
        type: 'barter_accepted',
        title: 'Sua troca foi aceita',
        data: { barterId: 5 },
      });
    });

    it('aceite recusado pelo service (sem saldo para a torna) não avisa ninguém', async () => {
      service.accept.mockRejectedValue(
        new HttpError(402, 'Saldo insuficiente', 'insufficient_balance'),
      );
      const res = await request(app).post('/api/barters/5/accept').set(bearer(7)).expect(402);
      expect(res.body.error).toBe('insufficient_balance');
      expect(notify).not.toHaveBeenCalled();
    });

    it('id inválido é recusado antes do service, e ninguém é avisado', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app).post(`/api/barters/${id}/accept`).set(bearer(7));
        expect(res.status, id).toBe(422);
        expect(Object.keys(res.body.details), id).toEqual(['id']);
      }
      expect(service.accept).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('quem aceita é sempre quem está logado: o corpo não escolhe outro usuário', async () => {
      service.accept.mockResolvedValue({ id: 5, proposerId: 1 });
      await request(app)
        .post('/api/barters/5/accept')
        .set(bearer(7))
        .send({ uid: 2, receiverId: 2, id: 99 })
        .expect(200);
      expect(service.accept).toHaveBeenCalledTimes(1);
      expect(service.accept).toHaveBeenCalledWith(5, 7);
    });
  });

  describe('POST /api/barters/:id/reject e /cancel', () => {
    it('recusar responde 204 sem corpo e chama só a recusa, com o id e quem está logado', async () => {
      service.reject.mockResolvedValue(undefined);
      const res = await request(app).post('/api/barters/5/reject').set(bearer(7)).expect(204);
      expect(res.text).toBe('');
      expect(service.reject).toHaveBeenCalledTimes(1);
      expect(service.reject).toHaveBeenCalledWith(5, 7);
      expect(service.cancel).not.toHaveBeenCalled();
      expect(service.accept).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('cancelar responde 204 sem corpo e chama só o cancelamento, com o id e quem está logado', async () => {
      service.cancel.mockResolvedValue(undefined);
      const res = await request(app).post('/api/barters/5/cancel').set(bearer(7)).expect(204);
      expect(res.text).toBe('');
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.cancel).toHaveBeenCalledWith(5, 7);
      expect(service.reject).not.toHaveBeenCalled();
      expect(service.accept).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('recusa ou cancelamento barrado pelo service devolve o status e o código dele', async () => {
      service.reject.mockRejectedValue(
        new HttpError(403, 'Apenas quem recebeu a proposta pode recusar', 'forbidden'),
      );
      const rejected = await request(app).post('/api/barters/5/reject').set(bearer(1)).expect(403);
      expect(rejected.body.error).toBe('forbidden');

      service.cancel.mockRejectedValue(
        new HttpError(409, 'Só é possível cancelar uma troca ainda proposta', 'invalid_status'),
      );
      const cancelled = await request(app).post('/api/barters/5/cancel').set(bearer(1)).expect(409);
      expect(cancelled.body).toEqual({
        error: 'invalid_status',
        message: 'Só é possível cancelar uma troca ainda proposta',
      });
    });

    it('id inválido é recusado antes do service', async () => {
      for (const id of ['0', 'x', '-3', '1.5']) {
        for (const action of ['reject', 'cancel']) {
          const res = await request(app).post(`/api/barters/${id}/${action}`).set(bearer(7));
          expect(res.status, `${id}/${action}`).toBe(422);
          expect(Object.keys(res.body.details), `${id}/${action}`).toEqual(['id']);
        }
      }
      expect(service.reject).not.toHaveBeenCalled();
      expect(service.cancel).not.toHaveBeenCalled();
    });
  });
});
