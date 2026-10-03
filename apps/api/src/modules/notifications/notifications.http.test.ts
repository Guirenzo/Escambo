import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { notificationsRoutes } from './notifications.routes';

const { service, push, audit } = vi.hoisted(() => ({
  service: {
    list: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    getEmailPreference: vi.fn(),
    setEmailPreference: vi.fn(),
  },
  push: {
    publicKey: vi.fn(),
    devices: vi.fn(),
    subscribed: vi.fn(),
    held: vi.fn(),
    deliversWork: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendTest: vi.fn(),
  },
  audit: { log: vi.fn() },
}));
vi.mock('./notifications.service', () => ({ notificationsService: service }));
vi.mock('./push.service', () => ({ pushService: push }));
vi.mock('../audit/audit.service', () => ({ auditService: audit }));

const app = routerApp('/api/notifications', notificationsRoutes);

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/aparelho-1';
const subscription = {
  endpoint: ENDPOINT,
  p256dh: 'chave-p256dh-do-aparelho',
  auth: 'segredo-auth',
};
const preference = {
  emailFrequency: 'daily',
  digestHour: 8,
  timezone: 'America/Sao_Paulo',
  quietHours: { start: 22, end: 7 },
  quietPass: ['deadline'],
};
const originalProvider = env.PUSH_PROVIDER;

/**
 * Rotas e controllers das notificações e dos avisos push: quem pode chamar, o que a validação
 * recusa, o que chega aos services (sempre com o uid de quem está logado) e a trilha de auditoria
 * do consentimento (LGPD art. 8 §2, ADR 54 e 56).
 */
describe('notificações: borda HTTP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.log.mockResolvedValue(undefined);
  });
  afterEach(() => {
    env.PUSH_PROVIDER = originalProvider;
  });

  it('todas as rotas exigem login: sem token é 401 e nada chega aos services', async () => {
    const routes: ['get' | 'post' | 'put' | 'delete', string][] = [
      ['get', '/api/notifications'],
      ['get', '/api/notifications/preferences'],
      ['put', '/api/notifications/preferences'],
      ['get', '/api/notifications/push'],
      ['post', '/api/notifications/push'],
      ['delete', '/api/notifications/push'],
      ['post', '/api/notifications/push/test'],
      ['post', '/api/notifications/read-all'],
      ['post', '/api/notifications/5/read'],
    ];
    for (const [method, path] of routes) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    for (const fn of [...Object.values(service), ...Object.values(push), audit.log]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('token inválido também é barrado', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set({ Authorization: 'Bearer nao-e-um-jwt' })
      .expect(401);
    expect(res.body.error).toBe('invalid_token');
    expect(service.list).not.toHaveBeenCalled();
  });

  describe('GET /api/notifications', () => {
    it('lista as notificações de quem está logado, com a paginação padrão', async () => {
      const list = { items: [], unreadCount: 0, page: 1, limit: 20 };
      service.list.mockResolvedValue(list);

      const res = await request(app).get('/api/notifications').set(bearer(7)).expect(200);

      expect(res.body).toEqual(list);
      expect(service.list).toHaveBeenCalledWith(7, 1, 20);
    });

    it('página e limite da URL chegam ao service como números', async () => {
      service.list.mockResolvedValue({ items: [], unreadCount: 0, page: 3, limit: 50 });

      await request(app).get('/api/notifications?page=3&limit=50').set(bearer(7)).expect(200);

      expect(service.list).toHaveBeenCalledWith(7, 3, 50);
    });

    it('o limite de 100 por página é o teto e ainda vale', async () => {
      service.list.mockResolvedValue({ items: [], unreadCount: 0, page: 1, limit: 100 });

      await request(app).get('/api/notifications?limit=100').set(bearer(7)).expect(200);

      expect(service.list.mock.calls).toEqual([[7, 1, 100]]);
    });

    it('a falha do service vira o 500 padronizado, sem detalhe interno na resposta', async () => {
      service.list.mockRejectedValueOnce(new Error('ER_ACCESS_DENIED para escambo@10.0.0.5'));

      const res = await request(app).get('/api/notifications').set(bearer(7)).expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });

    it('limite acima de 100, página zero ou texto no lugar do número são recusados na validação', async () => {
      const overLimit = await request(app).get('/api/notifications?limit=101').set(bearer(7));
      expect(overLimit.status).toBe(422);
      expect(overLimit.body.error).toBe('validation_error');
      expect(overLimit.body.details).toHaveProperty('limit');
      const pageZero = await request(app)
        .get('/api/notifications?page=0')
        .set(bearer(7))
        .expect(422);
      expect(pageZero.body.details).toHaveProperty('page');
      await request(app).get('/api/notifications?page=abc').set(bearer(7)).expect(422);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/notifications/:id/read', () => {
    it('marca como lida a notificação pedida, em nome de quem está logado, e responde sem corpo', async () => {
      service.markRead.mockResolvedValue(undefined);

      const res = await request(app).post('/api/notifications/5/read').set(bearer(7)).expect(204);

      expect(res.text).toBe('');
      expect(service.markRead).toHaveBeenCalledWith(5, 7);
    });

    it('id que não é um inteiro positivo é recusado', async () => {
      for (const id of ['abc', '0', '-3', '1.5']) {
        const res = await request(app).post(`/api/notifications/${id}/read`).set(bearer(7));
        expect(res.status, id).toBe(422);
        expect(res.body.details).toHaveProperty('id');
      }
      expect(service.markRead).not.toHaveBeenCalled();
    });

    it('notificação de outra pessoa (ou inexistente) volta como o 404 do service', async () => {
      service.markRead.mockRejectedValue(
        new HttpError(404, 'Notificação não encontrada', 'notification_not_found'),
      );

      const res = await request(app).post('/api/notifications/5/read').set(bearer(7)).expect(404);

      expect(res.body).toEqual({
        error: 'notification_not_found',
        message: 'Notificação não encontrada',
      });
    });
  });

  describe('POST /api/notifications/read-all', () => {
    it('marca todas as de quem está logado e devolve quantas eram', async () => {
      service.markAllRead.mockResolvedValue(4);

      const res = await request(app).post('/api/notifications/read-all').set(bearer(7)).expect(200);

      expect(res.body).toEqual({ read: 4 });
      expect(service.markAllRead).toHaveBeenCalledWith(7);
      // "read-all" é rota própria: não cai em /:id/read.
      expect(service.markRead).not.toHaveBeenCalled();
    });
  });

  describe('preferências de aviso (ADR 27, 42, 54 e 56)', () => {
    it('GET devolve a preferência de quem está logado', async () => {
      service.getEmailPreference.mockResolvedValue(preference);

      const res = await request(app)
        .get('/api/notifications/preferences')
        .set(bearer(7))
        .expect(200);

      expect(res.body).toEqual(preference);
      expect(service.getEmailPreference).toHaveBeenCalledWith(7);
    });

    it('PUT muda só o que veio e devolve como ficou; sem mexer no que sai no silêncio, não há trilha', async () => {
      service.setEmailPreference.mockResolvedValue(preference);

      const res = await request(app)
        .put('/api/notifications/preferences')
        .set(bearer(7))
        .send({ emailFrequency: 'daily', digestHour: 8 })
        .expect(200);

      expect(res.body).toEqual(preference);
      expect(service.setEmailPreference).toHaveBeenCalledWith(7, {
        emailFrequency: 'daily',
        digestHour: 8,
      });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('PUT com null volta ao padrão (hora, fuso e janela chegam nulos), e campo fora da lista não chega ao service', async () => {
      service.setEmailPreference.mockResolvedValue({ ...preference, quietHours: null });

      await request(app)
        .put('/api/notifications/preferences')
        .set(bearer(7))
        .send({ digestHour: null, timezone: null, quietHours: null, userId: 99, role: 'admin' })
        .expect(200);

      const [uid, change] = service.setEmailPreference.mock.calls[0]!;
      expect(uid).toBe(7);
      // toStrictEqual: nem userId, nem role, nem chave indefinida sobrando.
      expect(change).toStrictEqual({ digestHour: null, timezone: null, quietHours: null });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('a preferência é sempre a de quem está logado: outro uid no token, outro uid no service e na trilha', async () => {
      service.setEmailPreference.mockResolvedValue(preference);
      service.getEmailPreference.mockResolvedValue(preference);

      await request(app)
        .put('/api/notifications/preferences')
        .set(bearer(12, 'freelancer'))
        .send({ timezone: 'America/Manaus', quietPass: ['deadline'] })
        .expect(200);
      await request(app)
        .get('/api/notifications/preferences')
        .set(bearer(12, 'freelancer'))
        .expect(200);

      expect(service.setEmailPreference).toHaveBeenCalledWith(12, {
        timezone: 'America/Manaus',
        quietPass: ['deadline'],
      });
      expect(service.getEmailPreference).toHaveBeenCalledWith(12);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ userId: 12 }));
    });

    it('PUT com o que sai no silêncio deixa a trilha de quem escolheu, de onde e com qual navegador (ADR 56)', async () => {
      service.setEmailPreference.mockResolvedValue(preference);

      await request(app)
        .put('/api/notifications/preferences')
        .set(bearer(7))
        .set('User-Agent', 'Navegador de Teste/1.0')
        .send({ quietPass: ['deadline'], quietHours: { start: 22, end: 7 } })
        .expect(200);

      expect(service.setEmailPreference).toHaveBeenCalledWith(7, {
        quietPass: ['deadline'],
        quietHours: { start: 22, end: 7 },
      });
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({
        userId: 7,
        action: 'push_quiet_pass_changed',
        entityType: 'user',
        newValue: { quietPass: ['deadline'] },
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: 'Navegador de Teste/1.0',
      });
    });

    it('escolher "nada sai" (lista vazia) também é uma escolha e também fica na trilha', async () => {
      service.setEmailPreference.mockResolvedValue({ ...preference, quietPass: [] });

      await request(app)
        .put('/api/notifications/preferences')
        .set(bearer(7))
        .send({ quietPass: [] })
        .expect(200);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 7,
          action: 'push_quiet_pass_changed',
          newValue: { quietPass: [] },
        }),
      );
    });

    it('PUT vazio, meia janela de silêncio ou categoria desconhecida são recusados e nada é gravado', async () => {
      const bodies = [
        {},
        { quietHours: { start: 22 } },
        { quietHours: { start: 7, end: 7 } },
        { quietPass: ['tudo'] },
        // Categoria repetida, ou null (não existe "voltar a nunca ter escolhido", ADR 56).
        { quietPass: ['deadline', 'deadline'] },
        { quietPass: null },
        { emailFrequency: 'semanal' },
        { digestHour: 24 },
        // Só fusos do Brasil (ADR 46).
        { timezone: 'Europe/Lisbon' },
        // Campo desconhecido sozinho não é mudança nenhuma.
        { userId: 99 },
      ];
      for (const body of bodies) {
        const res = await request(app)
          .put('/api/notifications/preferences')
          .set(bearer(7))
          .send(body);
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect(res.body.error).toBe('validation_error');
      }
      expect(service.setEmailPreference).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('se gravar a preferência falha, a trilha não registra uma escolha que não valeu', async () => {
      service.setEmailPreference.mockRejectedValue(new Error('banco fora'));

      const res = await request(app)
        .put('/api/notifications/preferences')
        .set(bearer(7))
        .send({ quietPass: ['deadline'] })
        .expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/notifications/push (ADR 52)', () => {
    beforeEach(() => {
      push.publicKey.mockReturnValue('chave-publica-vapid');
      push.devices.mockResolvedValue(2);
      push.held.mockResolvedValue(3);
      push.deliversWork.mockResolvedValue(true);
    });

    it('sem o endpoint do aparelho: chave pública, aparelhos, retidos e quem entrega trabalho, sem consultar assinatura', async () => {
      const res = await request(app).get('/api/notifications/push').set(bearer(7)).expect(200);

      expect(res.body).toEqual({
        publicKey: 'chave-publica-vapid',
        devices: 2,
        subscribed: false,
        held: 3,
        deliversWork: true,
      });
      expect(push.devices).toHaveBeenCalledWith(7);
      expect(push.held).toHaveBeenCalledWith(7);
      expect(push.deliversWork).toHaveBeenCalledWith(7);
      expect(push.subscribed).not.toHaveBeenCalled();
    });

    it('com o endpoint do aparelho, diz se a assinatura dele é desta conta', async () => {
      push.subscribed.mockResolvedValue(true);

      const res = await request(app)
        .get('/api/notifications/push')
        .query({ endpoint: ENDPOINT })
        .set(bearer(7))
        .expect(200);

      expect(res.body.subscribed).toBe(true);
      expect(push.subscribed).toHaveBeenCalledWith(7, ENDPOINT);
    });

    it('aparelho com assinatura de outra conta aparece como não assinado; quem só contrata não vê a escolha do silêncio', async () => {
      push.subscribed.mockResolvedValue(false);
      push.deliversWork.mockResolvedValue(false);
      push.devices.mockResolvedValue(0);
      push.held.mockResolvedValue(0);

      const res = await request(app)
        .get('/api/notifications/push')
        .query({ endpoint: ENDPOINT })
        .set(bearer(12))
        .expect(200);

      expect(res.body).toEqual({
        publicKey: 'chave-publica-vapid',
        devices: 0,
        subscribed: false,
        held: 0,
        deliversWork: false,
      });
      expect(push.subscribed).toHaveBeenCalledWith(12, ENDPOINT);
      expect(push.devices).toHaveBeenCalledWith(12);
      expect(push.held).toHaveBeenCalledWith(12);
      expect(push.deliversWork).toHaveBeenCalledWith(12);
    });

    it('endpoint que não é uma URL é recusado antes de qualquer consulta', async () => {
      const res = await request(app)
        .get('/api/notifications/push?endpoint=nada')
        .set(bearer(7))
        .expect(422);

      expect(res.body.details).toHaveProperty('endpoint');
      expect(push.devices).not.toHaveBeenCalled();
      expect(push.subscribed).not.toHaveBeenCalled();
    });

    it('com o canal desligado a chave pública volta vazia, e a tela ainda recebe o resto do estado', async () => {
      push.publicKey.mockReturnValue('');
      push.devices.mockResolvedValue(0);
      push.held.mockResolvedValue(0);

      const res = await request(app).get('/api/notifications/push').set(bearer(7)).expect(200);

      expect(res.body).toEqual({
        publicKey: '',
        devices: 0,
        subscribed: false,
        held: 0,
        deliversWork: true,
      });
    });

    it('erro de configuração do push (chave que falta) vira o 500 padronizado: o nome das variáveis não vai para o navegador', async () => {
      push.publicKey.mockImplementationOnce(() => {
        throw new Error('PUSH_PROVIDER=webpush exige PUSH_PUBLIC_KEY e PUSH_PRIVATE_KEY');
      });

      const res = await request(app).get('/api/notifications/push').set(bearer(7)).expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(JSON.stringify(res.body)).not.toContain('PUSH_');
    });
  });

  describe('POST /api/notifications/push: ligar os avisos neste aparelho', () => {
    it('assina em nome de quem está logado, devolve os aparelhos e deixa a trilha só com o host do serviço de push (ADR 54)', async () => {
      push.subscribe.mockResolvedValue(undefined);
      push.devices.mockResolvedValue(2);

      const res = await request(app)
        .post('/api/notifications/push')
        .set(bearer(7))
        .set('User-Agent', 'Navegador de Teste/1.0')
        .send(subscription)
        .expect(201);

      expect(res.body).toEqual({ devices: 2 });
      expect(push.subscribe).toHaveBeenCalledWith(7, subscription);
      expect(push.devices).toHaveBeenCalledWith(7);
      expect(audit.log).toHaveBeenCalledTimes(1);
      const entry = audit.log.mock.calls[0]![0] as Record<string, unknown>;
      expect(entry).toEqual({
        userId: 7,
        action: 'push_subscribed',
        entityType: 'push_subscription',
        newValue: { host: 'fcm.googleapis.com' },
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: 'Navegador de Teste/1.0',
      });
      // O endereço inteiro identifica o aparelho: nunca vai para a trilha.
      expect(JSON.stringify(entry)).not.toContain('aparelho-1');
    });

    it('campos a mais no corpo (como o id de outra conta) não chegam ao service', async () => {
      push.subscribe.mockResolvedValue(undefined);
      push.devices.mockResolvedValue(1);

      await request(app)
        .post('/api/notifications/push')
        .set(bearer(7))
        .send({ ...subscription, userId: 99, user_agent: 'x' })
        .expect(201);

      expect(push.subscribe).toHaveBeenCalledWith(7, subscription);
    });

    it('endpoint sem https, apontando para IP, ou chaves curtas demais são recusados: nada é gravado nem auditado', async () => {
      const bodies = [
        { ...subscription, endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
        { ...subscription, endpoint: 'https://10.0.0.5/push' },
        { ...subscription, endpoint: 'nada' },
        { ...subscription, endpoint: `https://fcm.googleapis.com/${'x'.repeat(520)}` },
        { ...subscription, p256dh: 'curta' },
        { ...subscription, auth: 'abc' },
        { endpoint: ENDPOINT },
      ];
      for (const body of bodies) {
        const res = await request(app).post('/api/notifications/push').set(bearer(7)).send(body);
        expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(422);
        expect(res.body.error).toBe('validation_error');
      }
      expect(push.subscribe).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('com envio de verdade (webpush), só vale endpoint de serviço de push conhecido: a API não vira sonda de rede', async () => {
      env.PUSH_PROVIDER = 'webpush';
      push.subscribe.mockResolvedValue(undefined);
      push.devices.mockResolvedValue(1);

      const res = await request(app)
        .post('/api/notifications/push')
        .set(bearer(7))
        .send({ ...subscription, endpoint: 'https://interno.escambo.test/push' })
        .expect(422);
      expect(res.body.details.endpoint).toEqual(['Endereço de push não aceito']);
      expect(push.subscribe).not.toHaveBeenCalled();

      await request(app)
        .post('/api/notifications/push')
        .set(bearer(7))
        .send(subscription)
        .expect(201);
      expect(push.subscribe).toHaveBeenCalledWith(7, subscription);
    });

    it('com o provedor simulado, qualquer host https serve (nada sai da máquina)', async () => {
      env.PUSH_PROVIDER = 'simulated';
      push.subscribe.mockResolvedValue(undefined);
      push.devices.mockResolvedValue(1);
      const local = { ...subscription, endpoint: 'https://push.escambo.test/a' };

      await request(app).post('/api/notifications/push').set(bearer(7)).send(local).expect(201);

      expect(push.subscribe).toHaveBeenCalledWith(7, local);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ newValue: { host: 'push.escambo.test' } }),
      );
    });

    it('se a assinatura não foi gravada, não há trilha de consentimento nem resposta de sucesso', async () => {
      push.subscribe.mockRejectedValue(new Error('banco fora'));

      await request(app)
        .post('/api/notifications/push')
        .set(bearer(7))
        .send(subscription)
        .expect(500);

      expect(audit.log).not.toHaveBeenCalled();
      expect(push.devices).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/notifications/push: desligar este aparelho', () => {
    it('remove a assinatura de quem está logado, responde sem corpo e deixa a trilha com o host', async () => {
      push.unsubscribe.mockResolvedValue(true);

      const res = await request(app)
        .delete('/api/notifications/push')
        .set(bearer(7))
        .set('User-Agent', 'Navegador de Teste/1.0')
        .send({ endpoint: ENDPOINT })
        .expect(204);

      expect(res.text).toBe('');
      expect(push.unsubscribe).toHaveBeenCalledWith(7, ENDPOINT);
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({
        userId: 7,
        action: 'push_unsubscribed',
        entityType: 'push_subscription',
        newValue: { host: 'fcm.googleapis.com' },
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: 'Navegador de Teste/1.0',
      });
    });

    it('aparelho que não é desta conta: 404 e nenhuma trilha de desligamento', async () => {
      push.unsubscribe.mockResolvedValue(false);

      const res = await request(app)
        .delete('/api/notifications/push')
        .set(bearer(7))
        .send({ endpoint: ENDPOINT })
        .expect(404);

      expect(res.body).toEqual({ error: 'push_not_found', message: 'Aparelho não encontrado' });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('se a remoção falha, não há trilha de desligamento nem resposta de sucesso', async () => {
      push.unsubscribe.mockRejectedValue(new Error('banco fora'));

      const res = await request(app)
        .delete('/api/notifications/push')
        .set(bearer(7))
        .send({ endpoint: ENDPOINT })
        .expect(500);

      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('sem endpoint, ou com um que não é URL, é recusado na validação', async () => {
      await request(app).delete('/api/notifications/push').set(bearer(7)).send({}).expect(422);
      const res = await request(app)
        .delete('/api/notifications/push')
        .set(bearer(7))
        .send({ endpoint: 'nada' })
        .expect(422);
      expect(res.body.details).toHaveProperty('endpoint');
      expect(push.unsubscribe).not.toHaveBeenCalled();
    });

    it('endpoint maior que a coluna (512) é recusado ao desligar e ao consultar; no tamanho exato ainda vale', async () => {
      const base = 'https://fcm.googleapis.com/fcm/send/';
      const atLimit = base + 'x'.repeat(512 - base.length);
      const tooLong = `${atLimit}x`;
      push.unsubscribe.mockResolvedValue(true);
      push.subscribed.mockResolvedValue(true);
      push.publicKey.mockReturnValue('chave-publica-vapid');

      const del = await request(app)
        .delete('/api/notifications/push')
        .set(bearer(7))
        .send({ endpoint: tooLong })
        .expect(422);
      expect(del.body.details).toHaveProperty('endpoint');
      const get = await request(app)
        .get('/api/notifications/push')
        .query({ endpoint: tooLong })
        .set(bearer(7))
        .expect(422);
      expect(get.body.details).toHaveProperty('endpoint');
      expect(push.unsubscribe).not.toHaveBeenCalled();
      expect(push.subscribed).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();

      await request(app)
        .delete('/api/notifications/push')
        .set(bearer(7))
        .send({ endpoint: atLimit })
        .expect(204);
      expect(push.unsubscribe.mock.calls).toEqual([[7, atLimit]]);
      await request(app)
        .get('/api/notifications/push')
        .query({ endpoint: atLimit })
        .set(bearer(7))
        .expect(200);
      expect(push.subscribed.mock.calls).toEqual([[7, atLimit]]);
    });
  });

  describe('POST /api/notifications/push/test', () => {
    it('manda o aviso de teste para os aparelhos de quem está logado e devolve o resultado do envio', async () => {
      push.sendTest.mockResolvedValue({ sent: 1, removed: 0, failed: 1 });

      const res = await request(app)
        .post('/api/notifications/push/test')
        .set(bearer(7))
        .expect(200);

      expect(res.body).toEqual({ sent: 1, removed: 0, failed: 1 });
      // Só o uid: a hora do envio é a do servidor, não vem da requisição.
      expect(push.sendTest).toHaveBeenCalledWith(7);
      // "push/test" é rota própria: não assina aparelho nem cai em /:id/read.
      expect(push.subscribe).not.toHaveBeenCalled();
      expect(service.markRead).not.toHaveBeenCalled();
    });

    it('o aviso de teste vai para a conta do token (um userId no corpo não muda o destino) e não deixa trilha de consentimento', async () => {
      push.sendTest.mockResolvedValue({ sent: 0, removed: 0, failed: 0 });

      const res = await request(app)
        .post('/api/notifications/push/test')
        .set(bearer(12))
        .send({ userId: 7 })
        .expect(200);

      // Conta sem aparelho: o resultado zerado volta como está.
      expect(res.body).toEqual({ sent: 0, removed: 0, failed: 0 });
      expect(push.sendTest.mock.calls).toEqual([[12]]);
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  it('sem cabeçalho de navegador, a trilha registra userAgent nulo em vez de inventar um', async () => {
    push.unsubscribe.mockResolvedValue(true);

    await request(app)
      .delete('/api/notifications/push')
      .set(bearer(7))
      .unset('User-Agent')
      .send({ endpoint: ENDPOINT })
      .expect(204);

    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ userAgent: null }));
  });
});
